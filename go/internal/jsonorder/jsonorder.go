// Package jsonorder decodes and re-encodes JSON while preserving object key
// order, so editing one field of a user's settings.json doesn't reshuffle the
// rest of their file the way a map[string]any round-trip would.
//
// ponytail: covers exactly what the uninstall cleanup needs — read, tweak one
// key, write back in JSON.stringify(value, null, 2) shape. Not a general JSON
// library; reach for a real one if anything beyond that shows up.
package jsonorder

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// Member is one key/value pair of an Object, in source order.
type Member struct {
	Key   string
	Value any
}

// Object is a JSON object that remembers its key order.
type Object struct {
	Members []Member
}

func (o *Object) Get(key string) (any, bool) {
	for _, m := range o.Members {
		if m.Key == key {
			return m.Value, true
		}
	}
	return nil, false
}

// Set replaces an existing key in place, or appends a new one at the end.
func (o *Object) Set(key string, value any) {
	for i := range o.Members {
		if o.Members[i].Key == key {
			o.Members[i].Value = value
			return
		}
	}
	o.Members = append(o.Members, Member{Key: key, Value: value})
}

func (o *Object) Delete(key string) {
	for i := range o.Members {
		if o.Members[i].Key == key {
			o.Members = append(o.Members[:i], o.Members[i+1:]...)
			return
		}
	}
}

// Unmarshal parses JSON into *Object, []any, json.Number, string, bool or nil.
func Unmarshal(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	value, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	// Reject trailing garbage the way JSON.parse does.
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("jsonorder: unexpected trailing data")
	}
	return value, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	token, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return decodeFrom(dec, token)
}

func decodeFrom(dec *json.Decoder, token json.Token) (any, error) {
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return token, nil
	}

	switch delim {
	case '{':
		obj := &Object{}
		for dec.More() {
			keyToken, err := dec.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, errors.New("jsonorder: non-string object key")
			}
			value, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			obj.Members = append(obj.Members, Member{Key: key, Value: value})
		}
		if _, err := dec.Token(); err != nil { // consume '}'
			return nil, err
		}
		return obj, nil

	case '[':
		items := []any{}
		for dec.More() {
			item, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		if _, err := dec.Token(); err != nil { // consume ']'
			return nil, err
		}
		return items, nil
	}
	return nil, errors.New("jsonorder: unexpected delimiter")
}

// Marshal renders a value the way JSON.stringify(value, null, 2) does: two-space
// indent, no HTML escaping, no trailing newline.
func Marshal(value any) ([]byte, error) {
	var buf bytes.Buffer
	if err := write(&buf, value, ""); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

const indentStep = "  "

func write(buf *bytes.Buffer, value any, indent string) error {
	switch v := value.(type) {
	case *Object:
		if len(v.Members) == 0 {
			buf.WriteString("{}")
			return nil
		}
		inner := indent + indentStep
		buf.WriteString("{\n")
		for i, m := range v.Members {
			if i > 0 {
				buf.WriteString(",\n")
			}
			buf.WriteString(inner)
			if err := writeScalar(buf, m.Key); err != nil {
				return err
			}
			buf.WriteString(": ")
			if err := write(buf, m.Value, inner); err != nil {
				return err
			}
		}
		buf.WriteString("\n" + indent + "}")
		return nil

	case []any:
		if len(v) == 0 {
			buf.WriteString("[]")
			return nil
		}
		inner := indent + indentStep
		buf.WriteString("[\n")
		for i, item := range v {
			if i > 0 {
				buf.WriteString(",\n")
			}
			buf.WriteString(inner)
			if err := write(buf, item, inner); err != nil {
				return err
			}
		}
		buf.WriteString("\n" + indent + "]")
		return nil

	default:
		return writeScalar(buf, value)
	}
}

func writeScalar(buf *bytes.Buffer, value any) error {
	if num, ok := value.(json.Number); ok {
		buf.WriteString(num.String())
		return nil
	}
	var encoded bytes.Buffer
	enc := json.NewEncoder(&encoded)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return err
	}
	buf.WriteString(strings.TrimSuffix(encoded.String(), "\n"))
	return nil
}

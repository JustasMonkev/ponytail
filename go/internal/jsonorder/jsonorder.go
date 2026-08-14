// Package jsonorder decodes and re-encodes JSON while preserving object key
// order, so editing one field of a user's settings.json doesn't reshuffle the
// rest of their file the way a map[string]any round-trip would.
//
// Scalars are kept as their original bytes and re-emitted verbatim, so values
// the caller never touches survive exactly — including number formatting, lone
// surrogates, and U+2028/U+2029, all of which a decode/encode round-trip through
// encoding/json would rewrite or destroy.
//
// ponytail: covers exactly what the config and uninstall writers need — read,
// tweak one key, write back in JSON.stringify(value, null, 2) shape. Values
// passed to Set should be scalars (string, bool, number) or jsonorder values;
// a map or slice is emitted compactly rather than pretty-printed. Reach for a
// real JSON library if anything beyond that shows up.
package jsonorder

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
)

// maxDepth bounds recursion so a hostile or generated settings.json can't drive
// the parser into a stack overflow. Real config files are a handful deep; past
// this the document is treated as malformed and the caller leaves it untouched.
const maxDepth = 10000

var (
	errTooDeep      = errors.New("jsonorder: nesting too deep")
	errNonStringKey = errors.New("jsonorder: non-string object key")
	errInvalidJSON  = errors.New("jsonorder: invalid JSON")
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

// AsString returns the string a decoded scalar holds. Anything that is not a
// JSON string reports false.
func AsString(value any) (string, bool) {
	raw, ok := value.(json.RawMessage)
	if !ok {
		if s, isString := value.(string); isString {
			return s, true
		}
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

// Unmarshal parses JSON into *Object, []any, or json.RawMessage for scalars.
func Unmarshal(data []byte) (any, error) {
	// json.Valid rejects malformed input and trailing garbage the way JSON.parse
	// does, so the walk below only ever sees well-formed bytes.
	if !json.Valid(data) {
		return nil, errInvalidJSON
	}
	return parseValue(data, 0)
}

func parseValue(raw []byte, depth int) (any, error) {
	if depth > maxDepth {
		return nil, errTooDeep
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, errInvalidJSON
	}

	switch trimmed[0] {
	case '{':
		dec := json.NewDecoder(bytes.NewReader(trimmed))
		if _, err := dec.Token(); err != nil { // consume '{'
			return nil, err
		}
		obj := &Object{}
		for dec.More() {
			keyToken, err := dec.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, errNonStringKey
			}
			var member json.RawMessage
			if err := dec.Decode(&member); err != nil {
				return nil, err
			}
			value, err := parseValue(member, depth+1)
			if err != nil {
				return nil, err
			}
			// JSON and JS agree that a repeated key overwrites: the last value
			// wins and the key keeps its first position. Appending both instead
			// would let a lookup return a value the host never sees.
			obj.Set(key, value)
		}
		if _, err := dec.Token(); err != nil { // consume '}'
			return nil, err
		}
		return obj, nil

	case '[':
		dec := json.NewDecoder(bytes.NewReader(trimmed))
		if _, err := dec.Token(); err != nil { // consume '['
			return nil, err
		}
		items := []any{}
		for dec.More() {
			var element json.RawMessage
			if err := dec.Decode(&element); err != nil {
				return nil, err
			}
			item, err := parseValue(element, depth+1)
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		if _, err := dec.Token(); err != nil { // consume ']'
			return nil, err
		}
		return items, nil

	default:
		return json.RawMessage(trimmed), nil
	}
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
	// A scalar that came from Unmarshal is re-emitted byte-for-byte, so untouched
	// values keep their exact literal form.
	if raw, ok := value.(json.RawMessage); ok {
		buf.Write(raw)
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

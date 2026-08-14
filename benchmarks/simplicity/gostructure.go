//go:build ignore

// Structural complexity metrics for Go sources, via go/ast. Emits JSON per function.
//
// Only metrics that (a) all four independent metric designs agreed on and (b) rank the
// validation pair correctly are computed. No weighted composite: weights fitted to one
// observed example are overfitting, so the metrics are reported as a vector and an arm
// must win a majority of them. See SPEC.md.
//
// Usage: go run gostructure.go <file.go> [<file.go>...]
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"strings"
)

type fn struct {
	File string `json:"file"`
	Name string `json:"name"`
	// Cognitive complexity (Campbell): branches cost 1 + nesting depth; boolean
	// operator chains cost 1 flat; non-local jumps cost 1 flat. Reported per
	// function — the aggregate is MAX, never SUM, because summing punishes
	// extraction, which is the exact bug this suite exists to catch.
	Cognitive int `json:"cognitive"`
	MaxNest   int `json:"max_nest"`
	// OutcomeSites: the largest group of identical terminal statements (returns,
	// loop jumps, accumulator writes). What costs a reader is not having several
	// returns, it is producing ONE outcome from several places.
	OutcomeSites int `json:"outcome_sites"`
	LiveMax      int `json:"live_max"`
	Statements   int `json:"statements"`
	Params       int `json:"params"`
}

func nodeText(fset *token.FileSet, n ast.Node) string {
	var b strings.Builder
	printer.Fprint(&b, fset, n)
	return strings.Join(strings.Fields(b.String()), " ")
}

func analyse(fset *token.FileSet, path string, f *ast.FuncDecl) fn {
	m := fn{File: path, Name: f.Name.Name}
	if f.Type.Params != nil {
		for _, p := range f.Type.Params.List {
			m.Params += len(p.Names)
		}
	}
	outcomes := map[string]int{}
	declared := map[string]bool{}

	var walk func(n ast.Node, depth int)
	walk = func(n ast.Node, depth int) {
		if depth > m.MaxNest {
			m.MaxNest = depth
		}
		ast.Inspect(n, func(c ast.Node) bool {
			if c == n {
				return true
			}
			switch t := c.(type) {
			case *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt, *ast.TypeSwitchStmt, *ast.SwitchStmt, *ast.SelectStmt:
				m.Cognitive += 1 + depth
				walk(c, depth+1)
				return false
			case *ast.FuncLit:
				walk(t.Body, depth+1)
				return false
			case *ast.BinaryExpr:
				// A chain of like operators costs 1, not 1 per operator.
				if (t.Op == token.LAND || t.Op == token.LOR) && !sameOp(t.X, t.Op) {
					m.Cognitive++
				}
			case *ast.BranchStmt:
				if t.Tok == token.CONTINUE || t.Tok == token.BREAK || t.Tok == token.GOTO {
					m.Cognitive++
					outcomes[t.Tok.String()]++
				}
			case *ast.ReturnStmt:
				outcomes["return "+nodeText(fset, t)]++
			case *ast.AssignStmt:
				if t.Tok == token.DEFINE {
					for _, lhs := range t.Lhs {
						if id, ok := lhs.(*ast.Ident); ok {
							declared[id.Name] = true
						}
					}
				} else {
					outcomes["write "+nodeText(fset, t)]++
				}
			}
			return true
		})
	}
	walk(f.Body, 1)

	ast.Inspect(f.Body, func(c ast.Node) bool {
		if _, ok := c.(ast.Stmt); ok {
			m.Statements++
		}
		return true
	})
	for _, n := range outcomes {
		if n > m.OutcomeSites {
			m.OutcomeSites = n
		}
	}
	m.LiveMax = len(declared) + m.Params
	return m
}

// sameOp reports whether the left operand continues the same boolean chain, so
// `a && b && c` is charged once rather than twice.
func sameOp(x ast.Expr, op token.Token) bool {
	b, ok := x.(*ast.BinaryExpr)
	return ok && b.Op == op
}

func main() {
	fset := token.NewFileSet()
	var out []fn
	for _, path := range os.Args[1:] {
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		for _, d := range file.Decls {
			if f, ok := d.(*ast.FuncDecl); ok && f.Body != nil {
				out = append(out, analyse(fset, path, f))
			}
		}
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.Encode(out)
}

package parser

import "testing"

func TestUnit_rootParserWorks(t *testing.T) {
	if got := TestUnit_rootParser(); got != "root" {
		t.Fatalf("got %q", got)
	}
}

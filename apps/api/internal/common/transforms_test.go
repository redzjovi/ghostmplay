package common

import "testing"

func TestToCSV(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		present bool
		want    string
		wantOK  bool
	}{
		{"absent", "", false, "", false},
		{"single", "Armor", true, "Armor", true},
		{"csv", "Armor,Weapon", true, "Armor,Weapon", true},
		{"csv with spaces", " Armor , Weapon ", true, "Armor,Weapon", true},
		{"csv trims and drops blanks", "Armor,,,Weapon", true, "Armor,Weapon", true},
		{"only commas", " , , ", true, "", false},
		{"whitespace only", "   ", true, "", false},
		{"single padded", "  Armor  ", true, "Armor", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := ToCSV(tt.value, tt.present)
			if got != tt.want || ok != tt.wantOK {
				t.Errorf("ToCSV(%q, %v) = (%q, %v), want (%q, %v)",
					tt.value, tt.present, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestToOptionalIntIgnoresEmpty(t *testing.T) {
	// The empty-string cases are the whole reason this function exists. An empty
	// filter box sends `?level=`, and parsing that as 0 would silently filter
	// the list to level-zero items instead of ignoring the filter.
	for _, value := range []string{"", "   "} {
		if _, ok := ToOptionalInt(value, true); ok {
			t.Errorf("ToOptionalInt(%q, true) was supplied, want ignored", value)
		}
	}
	if _, ok := ToOptionalInt("0", false); ok {
		t.Error("an absent parameter was supplied")
	}

	got, ok := ToOptionalInt("5", true)
	if !ok || got == nil || *got != 5 {
		t.Errorf("ToOptionalInt(\"5\") = (%v, %v), want (5, true)", got, ok)
	}

	// Truncation toward zero, so a float page number behaves like an integer.
	trunc, _ := ToOptionalInt("3.9", true)
	if trunc == nil || *trunc != 3 {
		t.Errorf("ToOptionalInt(\"3.9\") = %v, want 3", trunc)
	}
}

func TestToOptionalIntRejectsGarbage(t *testing.T) {
	for _, value := range []string{"abc", "NaN", "Inf", "1e400", "12abc"} {
		if _, ok := ToOptionalInt(value, true); ok {
			t.Errorf("ToOptionalInt(%q, true) was supplied, want ignored", value)
		}
	}
}

func TestToOptionalFloat(t *testing.T) {
	if _, ok := ToOptionalFloat("", true); ok {
		t.Error("an empty priceMin was supplied, want ignored")
	}
	got, ok := ToOptionalFloat("12.5", true)
	if !ok || got == nil || *got != 12.5 {
		t.Errorf("ToOptionalFloat(\"12.5\") = (%v, %v), want (12.5, true)", got, ok)
	}
	// Zero is a real price and must survive: filtering to free items is a
	// question the UI can ask.
	zero, ok := ToOptionalFloat("0", true)
	if !ok || zero == nil || *zero != 0 {
		t.Errorf("ToOptionalFloat(\"0\") = (%v, %v), want (0, true)", zero, ok)
	}
	if _, ok := ToOptionalFloat("abc", true); ok {
		t.Error("a non-numeric priceMin was supplied, want ignored")
	}
}

func TestToOptionalString(t *testing.T) {
	for _, value := range []string{"", "   ", "\t\n"} {
		if _, ok := ToOptionalString(value, true); ok {
			t.Errorf("ToOptionalString(%q, true) was supplied, want ignored", value)
		}
	}
	if _, ok := ToOptionalString("", false); ok {
		t.Error("an absent parameter was supplied")
	}

	got, ok := ToOptionalString("  Armor  ", true)
	if !ok || got == nil || *got != "Armor" {
		t.Errorf("ToOptionalString(\"  Armor  \") = (%v, %v), want (\"Armor\", true)", got, ok)
	}
}

func TestToOptionalBool(t *testing.T) {
	truthy := []string{"true", "TRUE", "1", "on", "yes", "  Yes  "}
	for _, value := range truthy {
		got, ok := ToOptionalBool(value, true)
		if !ok || got == nil || !*got {
			t.Errorf("ToOptionalBool(%q) = (%v, %v), want (true, true)", value, got, ok)
		}
	}

	falsy := []string{"false", "FALSE", "0", "off", "no"}
	for _, value := range falsy {
		got, ok := ToOptionalBool(value, true)
		if !ok || got == nil || *got {
			t.Errorf("ToOptionalBool(%q) = (%v, %v), want (false, true)", value, got, ok)
		}
	}

	// Unrecognised is "not supplied", not false. Guessing false would apply a
	// filter the client never asked for.
	for _, value := range []string{"", "maybe", "2"} {
		if _, ok := ToOptionalBool(value, true); ok {
			t.Errorf("ToOptionalBool(%q, true) was supplied, want ignored", value)
		}
	}

	// `?claimed=false` must be distinguishable from no `claimed` at all.
	// Filtering to unclaimed transfers is a question the UI actually asks.
	got, ok := ToOptionalBool("false", true)
	if !ok || got == nil || *got {
		t.Error("an explicit false was not preserved as a supplied value")
	}
}

func TestSplitCSV(t *testing.T) {
	tests := []struct {
		in   string
		want []string
	}{
		{"Armor", []string{"Armor"}},
		{"Armor,Weapon", []string{"Armor", "Weapon"}},
		{" Armor , Weapon ", []string{"Armor", "Weapon"}},
		{"Armor,,Weapon", []string{"Armor", "Weapon"}},
		{"", nil},
		{"   ", nil},
		{" , , ", nil},
	}
	for _, tt := range tests {
		got := SplitCSV(tt.in)
		if len(got) != len(tt.want) {
			t.Errorf("SplitCSV(%q) = %v, want %v", tt.in, got, tt.want)
			continue
		}
		for i := range got {
			if got[i] != tt.want[i] {
				t.Errorf("SplitCSV(%q) = %v, want %v", tt.in, got, tt.want)
				break
			}
		}
	}
}

func TestStatusText(t *testing.T) {
	tests := map[int]string{
		400: "Bad Request",
		401: "Unauthorized",
		403: "Forbidden",
		404: "Not Found",
		409: "Conflict",
		503: "Service Unavailable",
		599: "Error",
	}
	for status, want := range tests {
		if got := StatusText(status); got != want {
			t.Errorf("StatusText(%d) = %q, want %q", status, got, want)
		}
	}
}

func TestErrorBodyRendersArraysForValidation(t *testing.T) {
	// The web client joins an array message with commas and takes a string
	// message as-is, so the two shapes both have to survive.
	validation := Validation([]string{"name is required", "sort is invalid"}).Body()
	if _, ok := validation.Message.([]string); !ok {
		t.Errorf("Validation message rendered as %T, want []string", validation.Message)
	}
	if validation.StatusCode != 400 || validation.Error != "Bad Request" {
		t.Errorf("Validation body = %+v, want 400 Bad Request", validation)
	}

	single := Conflict("Favorite \"a\" already exists").Body()
	if msg, ok := single.Message.(string); !ok || msg != "Favorite \"a\" already exists" {
		t.Errorf("Conflict message rendered as %v, want the string itself", single.Message)
	}
}

func TestAsErrorWrapsUnknownErrorsAsOpaque500(t *testing.T) {
	// A raw database error must never reach the client with its message intact:
	// it would leak table and column names.
	opaque := AsError(errTest{})
	if opaque.Status != 500 {
		t.Errorf("status = %d, want 500", opaque.Status)
	}
	if opaque.Message != "Internal server error" {
		t.Errorf("message = %q, want the opaque message", opaque.Message)
	}

	// An *Error passes through unchanged, including when wrapped.
	original := NotFound("Favorite not found")
	if got := AsError(original); got != original {
		t.Error("AsError did not return the original *Error")
	}
}

type errTest struct{}

func (errTest) Error() string { return "pq: relation \"marketplace_items\" does not exist" }

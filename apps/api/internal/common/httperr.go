// Package common holds the pieces every module needs: the error envelope,
// query-parameter parsing, and the two small concurrency primitives.
//
// The error envelope is the most load-bearing thing in this file. The web app
// reads `message` off every failed response and, when it is an array, joins it
// with commas. That client is not changing as part of the Go rewrite, so the
// shape below is a contract, not a style choice.
package common

import (
	"errors"
	"fmt"
)

// Error is an HTTP-shaped error. Handlers return one of these and the router
// renders it; nothing writes an error body by hand.
type Error struct {
	Status  int
	Message string
	// Messages is set only for validation failures, where the client joins it
	// into a single sentence. A single Message is used as-is.
	Messages []string
}

func (e *Error) Error() string {
	if len(e.Messages) > 0 {
		return fmt.Sprintf("%d: %v", e.Status, e.Messages)
	}
	return fmt.Sprintf("%d: %s", e.Status, e.Message)
}

// BadRequest is a malformed or invalid request.
func BadRequest(msg string) *Error { return &Error{Status: 400, Message: msg} }

// Unauthorized means no valid session was presented.
func Unauthorized(msg string) *Error { return &Error{Status: 401, Message: msg} }

// Forbidden means a valid session that lacks the required role.
func Forbidden(msg string) *Error { return &Error{Status: 403, Message: msg} }

// NotFound means the thing does not exist, or does not exist for this caller.
//
// The two are deliberately indistinguishable. Responding "that favorite belongs
// to someone else" would turn the API into an oracle for guessing other
// people's ids.
func NotFound(msg string) *Error { return &Error{Status: 404, Message: msg} }

// Conflict is a state clash: a duplicate name, or an operation that cannot run
// while something else is in progress.
func Conflict(msg string) *Error { return &Error{Status: 409, Message: msg} }

// ServiceUnavailable means a dependency the request needs is down. The health
// endpoint uses it to report an unreachable database.
func ServiceUnavailable(msg string) *Error { return &Error{Status: 503, Message: msg} }

// Validation is a failed request body: several problems at once, reported
// together.
func Validation(msgs []string) *Error {
	return &Error{Status: 400, Messages: msgs}
}

// ErrorBody is the wire shape of an error response.
//
// The three fields are exactly what NestJS produced, and the web client reads
// `message`. `error` is the human-readable status text and nothing in this app
// reads it, but dropping it would be a gratuitous difference from what the
// deployed client was written against.
type ErrorBody struct {
	StatusCode int      `json:"statusCode"`
	Message    any      `json:"message"`
	Error      string   `json:"error"`
	Stack      []string `json:"-"`
}

// StatusText maps a status code to its reason phrase, for the `error` field.
func StatusText(status int) string {
	switch status {
	case 400:
		return "Bad Request"
	case 401:
		return "Unauthorized"
	case 403:
		return "Forbidden"
	case 404:
		return "Not Found"
	case 409:
		return "Conflict"
	case 422:
		return "Unprocessable Entity"
	case 429:
		return "Too Many Requests"
	case 500:
		return "Internal Server Error"
	case 503:
		return "Service Unavailable"
	default:
		return "Error"
	}
}

// Body renders the error for the wire.
func (e *Error) Body() ErrorBody {
	msg := any(e.Message)
	if len(e.Messages) > 0 {
		msg = e.Messages
	}
	return ErrorBody{
		StatusCode: e.Status,
		Message:    msg,
		Error:      StatusText(e.Status),
	}
}

// AsError extracts an *Error from an error chain, or wraps a plain error as a
// 500.
//
// A database error reaching the client as its own message would leak schema
// details, so anything that is not already an *Error becomes an opaque 500 and
// is logged server-side instead.
func AsError(err error) *Error {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		return apiErr
	}
	return &Error{Status: 500, Message: "Internal server error"}
}

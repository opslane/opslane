package minio

import (
	"errors"
	"testing"

	minioSDK "github.com/minio/minio-go/v7"
)

func TestMapStatObjectErrorNotFound(t *testing.T) {
	err := mapStatObjectError(minioSDK.ErrorResponse{Code: "NoSuchKey"}, "missing.map")
	if !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("error = %v, want ErrObjectNotFound", err)
	}
}

func TestMapStatObjectErrorPreservesOtherErrors(t *testing.T) {
	original := errors.New("storage offline")
	if got := mapStatObjectError(original, "map"); !errors.Is(got, original) {
		t.Fatalf("error = %v, want original", got)
	}
}

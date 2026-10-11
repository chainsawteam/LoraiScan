.PHONY: build test compose-config

build:
	go build -o bin/loraiscan ./cmd/loraiscan

test:
	go test ./...
	npm --prefix scanner test

compose-config:
	docker compose --profile robin --profile eth --profile base --profile arb config --quiet

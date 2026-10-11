FROM golang:1.20-alpine AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/loraiscan ./cmd/loraiscan

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /out/loraiscan /usr/local/bin/loraiscan
ENTRYPOINT ["loraiscan"]

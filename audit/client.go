package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

func NewClient(baseURL, apiKey string, timeout time.Duration) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

func (c *Client) LookupAudit(ctx context.Context, chainID int, targetAddress string) (*LookupResponse, string, error) {
	endpoint := c.lookupEndpoint(chainID, targetAddress)
	body, err := c.doJSON(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, "", err
	}

	var resp LookupResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, string(body), err
	}

	return &resp, string(body), nil
}

func (c *Client) DeleteAuditLookup(ctx context.Context, chainID int, targetAddress string) (string, error) {
	endpoint := c.lookupEndpoint(chainID, targetAddress)
	body, err := c.doJSON(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return "", err
	}
	return string(body), nil
}

func (c *Client) lookupEndpoint(chainID int, targetAddress string) string {
	query := url.Values{}
	query.Set("chain_id", fmt.Sprintf("%d", chainID))
	query.Set("target_address", normalizeAddress(targetAddress))

	return fmt.Sprintf("%s/api/audits/lookup?%s", c.baseURL, query.Encode())
}

func (c *Client) CreateAudit(ctx context.Context, request *CreateAuditRequest) (*CreateAuditResponse, string, error) {
	body, err := c.doJSON(ctx, http.MethodPost, c.baseURL+"/api/audits", request)
	if err != nil {
		return nil, "", err
	}

	var resp CreateAuditResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, string(body), err
	}

	return &resp, string(body), nil
}

func (c *Client) GetAudit(ctx context.Context, runID string) (*AuditDetailResponse, string, error) {
	endpoint := fmt.Sprintf("%s/api/audits/%s", c.baseURL, url.PathEscape(runID))
	body, err := c.doJSON(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, "", err
	}

	var resp AuditDetailResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, string(body), err
	}

	return &resp, string(body), nil
}

func (c *Client) doJSON(ctx context.Context, method, endpoint string, payload interface{}) ([]byte, error) {
	var body io.Reader
	if payload != nil {
		buf := bytes.NewBuffer(nil)
		if err := json.NewEncoder(buf).Encode(payload); err != nil {
			return nil, err
		}
		body = buf
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return respBody, fmt.Errorf("audit api %s %s failed: status=%d body=%s", method, endpoint, resp.StatusCode, string(respBody))
	}

	return respBody, nil
}

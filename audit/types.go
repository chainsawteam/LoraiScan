package audit

import "time"

type Config struct {
	Enabled        bool
	BaseURL        string
	APIKey         string
	RPCURL         string
	RPCURLByChain  map[string]string
	ValidationMode string
	CodexMode      string
	Priority       int
	MaxRetries     int
	RequestTimeout time.Duration
	PollInterval   time.Duration
}

type LookupRun struct {
	RunID         string `json:"run_id"`
	Status        string `json:"status"`
	CurrentPhase  string `json:"current_phase"`
	LatestSummary string `json:"latest_summary"`
}

type LookupResponse struct {
	ChainID          int         `json:"chain_id"`
	TargetAddress    string      `json:"target_address"`
	NormalizedTarget string      `json:"normalized_target_address"`
	HasMatchingRuns  bool        `json:"has_matching_runs"`
	HasStartedAudit  bool        `json:"has_started_audit"`
	HasFinishedAudit bool        `json:"has_finished_audit"`
	ActiveRun        *LookupRun  `json:"active_run"`
	LatestRun        *LookupRun  `json:"latest_run"`
	RecentRuns       []LookupRun `json:"recent_runs"`
}

type CreateAuditRequest struct {
	CaseLabel              string `json:"case_label,omitempty"`
	ChainID                int    `json:"chain_id"`
	RPCURL                 string `json:"rpc_url"`
	TargetAddress          string `json:"target_address"`
	InputType              string `json:"input_type"`
	ValidationModeOverride string `json:"validation_mode_override"`
	CodexMode              string `json:"codex_mode,omitempty"`
	Priority               int    `json:"priority,omitempty"`
	MaxRetries             int    `json:"max_retries,omitempty"`
}

type CreateAuditResponse struct {
	Audit struct {
		JobID         string `json:"job_id"`
		RunID         string `json:"run_id"`
		CaseLabel     string `json:"case_label"`
		Status        string `json:"status"`
		ChainID       int    `json:"chain_id"`
		TargetAddress string `json:"target_address"`
	} `json:"audit"`
}

type AuditDetailResponse struct {
	Audit struct {
		Run struct {
			RunID         string `json:"run_id"`
			Status        string `json:"status"`
			CurrentPhase  string `json:"current_phase"`
			LatestSummary string `json:"latest_summary"`
		} `json:"run"`
		MachineSummary interface{} `json:"machine_summary"`
	} `json:"audit"`
}

type AuditRecord struct {
	ChainID         int
	ContractAddress string
	ChainName       string
	RemoteRunID     string
	RemoteStatus    string
	RemotePhase     string
	LatestSummary   string
	LastError       string
	LastLookupAt    *time.Time
	LastSubmitAt    *time.Time
	LastSyncAt      *time.Time
	RawLookupJSON   string
	RawRunJSON      string
	CreatedAt       *time.Time
	UpdatedAt       *time.Time
}

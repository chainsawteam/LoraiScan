package audit

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/spf13/viper"

	"github.com/chainsawteam/LoraiScan/config"
)

var (
	initOnce      sync.Once
	runtimeConfig Config
	client        *Client
)

func Init() {
	initOnce.Do(func() {
		runtimeConfig = loadConfig()
		if !runtimeConfig.Enabled {
			log.Printf("audit: 第三方审计未启用")
			return
		}
		if runtimeConfig.BaseURL == "" || runtimeConfig.APIKey == "" {
			log.Printf("audit: 第三方审计配置不完整，baseURL 或 apiKey 为空")
			return
		}

		client = NewClient(runtimeConfig.BaseURL, runtimeConfig.APIKey, runtimeConfig.RequestTimeout)
		log.Printf("audit: 第三方审计已启用，baseURL=%s", runtimeConfig.BaseURL)

		if runtimeConfig.PollInterval > 0 {
			go startStatusSyncLoop()
		}
	})
}

func Enabled() bool {
	return client != nil
}

func EnsureAudit(chainID int, chainName, contractAddress string) error {
	return EnsureAuditWithPriority(chainID, chainName, contractAddress, runtimeConfig.Priority)
}

func EnsureAuditWithPriority(chainID int, chainName, contractAddress string, priority int) error {
	if client == nil {
		return nil
	}
	if chainID == 0 {
		return fmt.Errorf("invalid chain id for contract %s", contractAddress)
	}

	address := normalizeAddress(contractAddress)
	now := time.Now()

	lookupCtx, lookupCancel := context.WithTimeout(context.Background(), runtimeConfig.RequestTimeout)
	defer lookupCancel()

	lookupResp, rawLookup, err := client.LookupAudit(lookupCtx, chainID, address)
	if err != nil {
		_ = UpsertRecord(&AuditRecord{
			ChainID:         chainID,
			ContractAddress: address,
			ChainName:       chainName,
			LastLookupAt:    &now,
			LastError:       err.Error(),
		})
		return err
	}

	record := recordFromLookup(chainID, chainName, address, lookupResp, rawLookup)
	record.LastLookupAt = &now
	record.LastError = ""
	if err := UpsertRecord(record); err != nil {
		return err
	}

	if lookupResp.HasMatchingRuns {
		log.Printf("audit: 合约 %s 命中历史审计记录，跳过创建", address)
		return nil
	}

	rpcURL := resolveRPCURL(chainName)
	if rpcURL == "" {
		return fmt.Errorf("audit rpc url is empty")
	}

	req := &CreateAuditRequest{
		CaseLabel:              fmt.Sprintf("%s-%d-%s", chainName, chainID, strings.TrimPrefix(address, "0x")),
		ChainID:                chainID,
		RPCURL:                 rpcURL,
		TargetAddress:          address,
		InputType:              "contract_address",
		ValidationModeOverride: runtimeConfig.ValidationMode,
		CodexMode:              runtimeConfig.CodexMode,
		Priority:               priority,
		MaxRetries:             runtimeConfig.MaxRetries,
	}

	createCtx, createCancel := context.WithTimeout(context.Background(), runtimeConfig.RequestTimeout)
	defer createCancel()

	createResp, rawRun, err := client.CreateAudit(createCtx, req)
	if err != nil {
		record.LastError = err.Error()
		_ = UpsertRecord(record)
		return err
	}

	record.RemoteRunID = createResp.Audit.RunID
	if record.RemoteRunID == "" {
		record.RemoteRunID = createResp.Audit.JobID
	}
	record.RemoteStatus = createResp.Audit.Status
	record.RemotePhase = ""
	record.LatestSummary = ""
	record.RawRunJSON = rawRun
	record.LastSubmitAt = &now
	record.LastSyncAt = &now
	record.LastError = ""
	if err := UpsertRecord(record); err != nil {
		return err
	}

	log.Printf("audit: 已为合约 %s 创建审计任务 run_id=%s", address, createResp.Audit.RunID)
	return nil
}

func DeleteAuditHistory(chainID int, chainName, contractAddress string) error {
	if client == nil {
		return nil
	}
	if chainID == 0 {
		return fmt.Errorf("invalid chain id for contract %s", contractAddress)
	}

	address := normalizeAddress(contractAddress)
	ctx, cancel := context.WithTimeout(context.Background(), runtimeConfig.RequestTimeout)
	defer cancel()

	rawResp, err := client.DeleteAuditLookup(ctx, chainID, address)
	if err != nil {
		return err
	}

	rowsAffected, localErr := DeleteRecord(chainID, address)
	if localErr != nil {
		log.Printf("audit: 删除本地映射记录失败 chain=%s contract=%s err=%v", chainName, address, localErr)
	}

	log.Printf("audit: 已删除服务端审计历史 chain=%s contract=%s local_rows=%d response=%s", chainName, address, rowsAffected, rawResp)
	return nil
}

func startStatusSyncLoop() {
	ticker := time.NewTicker(runtimeConfig.PollInterval)
	defer ticker.Stop()

	for {
		syncActiveAudits()
		<-ticker.C
	}
}

func syncActiveAudits() {
	records, err := ListActiveRecords(50)
	if err != nil {
		log.Printf("audit: 查询本地活跃任务失败: %v", err)
		return
	}

	for _, record := range records {
		ctx, cancel := context.WithTimeout(context.Background(), runtimeConfig.RequestTimeout)
		detailResp, rawRun, err := client.GetAudit(ctx, record.RemoteRunID)
		cancel()

		now := time.Now()
		if err != nil {
			record.LastSyncAt = &now
			record.LastError = err.Error()
			_ = UpsertRecord(&record)
			continue
		}

		record.RemoteStatus = detailResp.Audit.Run.Status
		record.RemotePhase = detailResp.Audit.Run.CurrentPhase
		record.LatestSummary = detailResp.Audit.Run.LatestSummary
		record.RawRunJSON = rawRun
		record.LastSyncAt = &now
		record.LastError = ""
		if err := UpsertRecord(&record); err != nil {
			log.Printf("audit: 更新任务状态失败 run_id=%s err=%v", record.RemoteRunID, err)
		}
	}
}

func loadConfig() Config {
	timeoutSec := getInt("Audit.requestTimeoutSec", "Plugin_newcontract.auditRequestTimeoutSec", 15)
	if timeoutSec <= 0 {
		timeoutSec = 15
	}

	pollSec := getInt("Audit.pollIntervalSec", "Plugin_newcontract.auditPollIntervalSec", 10)
	if pollSec <= 0 {
		pollSec = 10
	}

	validationMode := getString("Audit.validationMode", "Plugin_newcontract.auditValidationMode")
	if validationMode == "" {
		validationMode = "onchain_trace"
	}

	rpcURLByChain := map[string]string{}
	for key, value := range viper.GetStringMapString("Audit.rpcURLByChain") {
		rpcURLByChain[strings.ToUpper(strings.TrimSpace(key))] = strings.TrimSpace(value)
	}

	rpcURL := getString("Audit.rpcURL", "Plugin_newcontract.auditRPCURL")
	if rpcURL == "" {
		rpcURL = config.GetString("Web3.http")
	}

	return Config{
		Enabled:        getBool("Audit.enabled", "Plugin_newcontract.auditEnabled"),
		BaseURL:        strings.TrimRight(getString("Audit.baseURL", "Plugin_newcontract.auditBaseURL"), "/"),
		APIKey:         getString("Audit.apiKey", "Plugin_newcontract.auditAPIKey"),
		RPCURL:         rpcURL,
		RPCURLByChain:  rpcURLByChain,
		ValidationMode: validationMode,
		CodexMode:      getString("Audit.codexMode", "Plugin_newcontract.auditCodexMode"),
		Priority:       getInt("Audit.priority", "Plugin_newcontract.auditPriority", 100),
		MaxRetries:     getInt("Audit.maxRetries", "Plugin_newcontract.auditMaxRetries", 2),
		RequestTimeout: time.Duration(timeoutSec) * time.Second,
		PollInterval:   time.Duration(pollSec) * time.Second,
	}
}

func resolveRPCURL(chainName string) string {
	chainName = strings.ToUpper(strings.TrimSpace(chainName))
	if chainName != "" {
		if value := strings.TrimSpace(runtimeConfig.RPCURLByChain[chainName]); value != "" {
			return value
		}
	}
	return strings.TrimSpace(runtimeConfig.RPCURL)
}

func recordFromLookup(chainID int, chainName, contractAddress string, lookup *LookupResponse, rawLookup string) *AuditRecord {
	record := &AuditRecord{
		ChainID:         chainID,
		ContractAddress: contractAddress,
		ChainName:       chainName,
		RawLookupJSON:   rawLookup,
	}

	run := lookup.ActiveRun
	if run == nil {
		run = lookup.LatestRun
	}
	if run != nil {
		record.RemoteRunID = run.RunID
		record.RemoteStatus = run.Status
		record.RemotePhase = run.CurrentPhase
		record.LatestSummary = run.LatestSummary
	}

	return record
}

func normalizeAddress(address string) string {
	address = strings.TrimSpace(address)
	if strings.HasPrefix(address, "0x") || strings.HasPrefix(address, "0X") {
		return "0x" + strings.ToLower(address[2:])
	}
	return strings.ToLower(address)
}

func getString(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(viper.GetString(key)); value != "" {
			return value
		}
	}
	return ""
}

func getBool(keys ...string) bool {
	for _, key := range keys {
		if viper.IsSet(key) {
			return viper.GetBool(key)
		}
	}
	return false
}

func getInt(primaryKey string, fallbackKey string, defaultValue int) int {
	if primaryKey != "" && viper.IsSet(primaryKey) {
		return viper.GetInt(primaryKey)
	}
	if fallbackKey != "" && viper.IsSet(fallbackKey) {
		return viper.GetInt(fallbackKey)
	}
	return defaultValue
}

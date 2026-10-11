package audit

import (
	"database/sql"
	"time"

	"github.com/chainsawteam/LoraiScan/database"
)

func UpsertRecord(record *AuditRecord) error {
	if database.Primary == nil {
		return nil
	}

	query := `INSERT INTO contract_audits (
		chain_id, contract_address, chain_name,
		remote_run_id, remote_status, remote_phase,
		latest_summary, last_error,
		last_lookup_at, last_submit_at, last_sync_at,
		raw_lookup_json, raw_run_json,
		created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
	ON DUPLICATE KEY UPDATE
		chain_name = VALUES(chain_name),
		remote_run_id = VALUES(remote_run_id),
		remote_status = VALUES(remote_status),
		remote_phase = VALUES(remote_phase),
		latest_summary = VALUES(latest_summary),
		last_error = VALUES(last_error),
		last_lookup_at = VALUES(last_lookup_at),
		last_submit_at = VALUES(last_submit_at),
		last_sync_at = VALUES(last_sync_at),
		raw_lookup_json = VALUES(raw_lookup_json),
		raw_run_json = VALUES(raw_run_json),
		updated_at = NOW()`

	_, err := database.Primary.Exec(
		query,
		record.ChainID,
		normalizeAddress(record.ContractAddress),
		record.ChainName,
		toNullString(record.RemoteRunID),
		toNullString(record.RemoteStatus),
		toNullString(record.RemotePhase),
		toNullString(record.LatestSummary),
		toNullString(record.LastError),
		toNullTime(record.LastLookupAt),
		toNullTime(record.LastSubmitAt),
		toNullTime(record.LastSyncAt),
		toNullString(record.RawLookupJSON),
		toNullString(record.RawRunJSON),
	)

	return err
}

func ListActiveRecords(limit int) ([]AuditRecord, error) {
	if database.Primary == nil {
		return nil, nil
	}

	query := `SELECT chain_id, contract_address, chain_name,
		remote_run_id, remote_status, remote_phase,
		latest_summary, last_error,
		last_lookup_at, last_submit_at, last_sync_at,
		raw_lookup_json, raw_run_json,
		created_at, updated_at
	FROM contract_audits
	WHERE remote_run_id IS NOT NULL
	  AND remote_status IN ('queued', 'dispatching', 'running', 'cancelling')
	ORDER BY updated_at ASC`

	var (
		rows *sql.Rows
		err  error
	)
	if limit > 0 {
		query += ` LIMIT ?`
		rows, err = database.Primary.Query(query, limit)
	} else {
		rows, err = database.Primary.Query(query)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	records := make([]AuditRecord, 0)
	for rows.Next() {
		record, err := scanRecord(rows)
		if err != nil {
			continue
		}
		records = append(records, record)
	}

	return records, nil
}

func DeleteRecord(chainID int, contractAddress string) (int64, error) {
	if database.Primary == nil {
		return 0, nil
	}

	result, err := database.Primary.Exec(
		`DELETE FROM contract_audits WHERE chain_id = ? AND contract_address = ?`,
		chainID,
		normalizeAddress(contractAddress),
	)
	if err != nil {
		return 0, err
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return rowsAffected, nil
}

func scanRecord(scanner interface {
	Scan(dest ...interface{}) error
}) (AuditRecord, error) {
	var record AuditRecord
	var remoteRunID, remoteStatus, remotePhase, latestSummary, lastError sql.NullString
	var rawLookupJSON, rawRunJSON sql.NullString
	var lastLookupAt, lastSubmitAt, lastSyncAt sql.NullTime
	var createdAt, updatedAt sql.NullTime

	err := scanner.Scan(
		&record.ChainID,
		&record.ContractAddress,
		&record.ChainName,
		&remoteRunID,
		&remoteStatus,
		&remotePhase,
		&latestSummary,
		&lastError,
		&lastLookupAt,
		&lastSubmitAt,
		&lastSyncAt,
		&rawLookupJSON,
		&rawRunJSON,
		&createdAt,
		&updatedAt,
	)
	if err != nil {
		return record, err
	}

	record.RemoteRunID = remoteRunID.String
	record.RemoteStatus = remoteStatus.String
	record.RemotePhase = remotePhase.String
	record.LatestSummary = latestSummary.String
	record.LastError = lastError.String
	record.RawLookupJSON = rawLookupJSON.String
	record.RawRunJSON = rawRunJSON.String
	record.LastLookupAt = nullTimeToPtr(lastLookupAt)
	record.LastSubmitAt = nullTimeToPtr(lastSubmitAt)
	record.LastSyncAt = nullTimeToPtr(lastSyncAt)
	record.CreatedAt = nullTimeToPtr(createdAt)
	record.UpdatedAt = nullTimeToPtr(updatedAt)

	return record, nil
}

func toNullString(value string) sql.NullString {
	if value == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: value, Valid: true}
}

func toNullTime(value *time.Time) sql.NullTime {
	if value == nil || value.IsZero() {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: *value, Valid: true}
}

func nullTimeToPtr(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	t := value.Time
	return &t
}

package database

import (
	"database/sql"
	"fmt"

	_ "github.com/go-sql-driver/mysql"
)

var Primary *sql.DB

func Connect(dataSource string) error {
	if dataSource == "" {
		return fmt.Errorf("MySQL.dataSource is empty")
	}

	db, err := sql.Open("mysql", dataSource)
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(5)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return err
	}
	Primary = db
	return nil
}

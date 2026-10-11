package config

import (
	"fmt"
	"strings"

	"github.com/spf13/viper"
)

// Load reads the main YAML file and optionally merges audit.yaml from the
// same working directory. Environment variables can override every setting,
// for example MYSQL_DATASOURCE and AUDIT_APIKEY.
func Load(name string) error {
	viper.Reset()
	viper.SetConfigName(name)
	viper.SetConfigType("yaml")
	viper.AddConfigPath(".")
	viper.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	viper.AutomaticEnv()

	if err := viper.ReadInConfig(); err != nil {
		return fmt.Errorf("read %s: %w", name, err)
	}

	viper.SetConfigFile("audit.yaml")
	if err := viper.MergeInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return fmt.Errorf("merge audit.yaml: %w", err)
		}
	}
	return nil
}

func GetString(key string) string {
	return viper.GetString(key)
}

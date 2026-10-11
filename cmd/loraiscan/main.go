package main

import (
	"bufio"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/chainsawteam/LoraiScan/audit"
	"github.com/chainsawteam/LoraiScan/config"
	"github.com/chainsawteam/LoraiScan/database"
)

type contractRow struct {
	ID              int64
	ContractAddress string
	ChainID         sql.NullInt64
	ChainName       string
	ContractValue   float64
}

type tokenRow struct {
	ID           int64
	TokenAddress string
	ChainID      sql.NullInt64
	ChainName    string
	Symbol       sql.NullString
	TokenValue   float64
	RiskLevel    sql.NullInt64
	PairsCount   sql.NullInt64
}

type chainSummary struct {
	ChainName   string
	Count       int
	TotalValue  float64
	MaxValue    float64
	LatestValue float64
}

type tokenSortSQL struct {
	ValueExpr string
	JoinSQL   string
	JoinArgs  []interface{}
}

type dataSource string

const (
	dataSourceContracts dataSource = "contracts"
	dataSourceTokens    dataSource = "tokens"
)

type shellState struct {
	activeChain       string
	activeSource      dataSource
	tokenSortField    string
	tokenStepValues   map[string]float64
	listLimit         int
	minValue          float64
	sleepMS           int
	priorityBase      int
	priorityStepValue float64
	priorityMax       int
}

var currentShellSource = dataSourceContracts
var assetMYSQL *sql.DB
var assetDataSource string

func main() {
	configName := flag.String("config", "config", "config file name without extension")
	chainNameFlag := flag.String("chain", "", "default active chain")
	sourceFlag := flag.String("source", "", "default source: contracts or tokens; empty means interactive")
	tokenSortFlag := flag.String("token-sort", "", "default token sort field for source=tokens")
	assetDBDSN := flag.String("asset-db-dsn", defaultAssetDataSource(), "asset database DSN for source=tokens")
	minValue := flag.Float64("min-value", 0, "default minimum contract value")
	listLimit := flag.Int("limit", 20, "default list limit")
	sleepMS := flag.Int("sleep-ms", 200, "default delay between batch submissions in milliseconds")
	priorityBase := flag.Int("priority-base", 100, "minimum audit priority number; smaller numbers run earlier")
	priorityStepValue := flag.Float64("priority-step-value", 1000, "USD value needed to reduce the priority number by one step")
	priorityMax := flag.Int("priority-max", 10000, "maximum audit priority number; larger numbers run later")
	flag.Parse()

	if err := config.Load(*configName); err != nil {
		log.Fatalf("audit shell: load config: %v", err)
	}
	if err := database.Connect(config.GetString("MySQL.dataSource")); err != nil {
		log.Fatalf("audit shell: connect primary database: %v", err)
	}
	assetDataSource = strings.TrimSpace(*assetDBDSN)
	defer closeMySQL()

	audit.Init()
	if !audit.Enabled() {
		log.Fatalf("audit shell: 审计配置未启用或配置不完整")
	}

	activeChain := strings.TrimSpace(*chainNameFlag)
	if activeChain == "" {
		activeChain = config.GetString("System.name")
	}

	state := &shellState{
		activeChain:       strings.ToUpper(activeChain),
		tokenStepValues:   map[string]float64{},
		listLimit:         *listLimit,
		minValue:          *minValue,
		sleepMS:           *sleepMS,
		priorityBase:      *priorityBase,
		priorityStepValue: *priorityStepValue,
		priorityMax:       *priorityMax,
	}

	scanner := bufio.NewScanner(os.Stdin)
	if strings.TrimSpace(*sourceFlag) != "" {
		source, err := parseDataSource(*sourceFlag)
		if err != nil {
			log.Fatalf("audit shell: 初始化扫描源失败: %v", err)
		}
		state.activeSource = source
		currentShellSource = source
		if source == dataSourceTokens {
			sortField := *tokenSortFlag
			if strings.TrimSpace(sortField) == "" {
				sortField = defaultTokenSortField(state.activeChain)
			}
			sortField, err = normalizeTokenSortField(state.activeChain, sortField)
			if err != nil {
				log.Fatalf("audit shell: 初始化 token 排序字段失败: %v", err)
			}
			state.tokenSortField = sortField
			state.tokenStepValues[sortField] = state.priorityStepValue
		}
	} else if err := interactiveSetup(state, scanner); err != nil {
		log.Fatalf("audit shell: 初始化交互配置失败: %v", err)
	}

	printBanner(state)
	runShell(state, scanner)
}

func printBanner(state *shellState) {
	currentShellSource = state.activeSource
	fmt.Println("Lora Audit Shell")
	status := fmt.Sprintf(
		"activeChain=%s source=%s minValue=%.4f listLimit=%d sleepMS=%d priorityBase=%d priorityStepValue=%.2f priorityMax=%d",
		state.activeChain,
		state.activeSource,
		state.minValue,
		state.listLimit,
		state.sleepMS,
		state.priorityBase,
		state.priorityStepValue,
		state.priorityMax,
	)
	if state.activeSource == dataSourceTokens {
		status += fmt.Sprintf(" tokenSort=%s tokenStepValue=%.2f", state.tokenSortField, currentPriorityStepValue(state))
	}
	if state.activeSource == dataSourceTokens && assetDataSource != "" {
		status += " assetDB=configured"
	}
	fmt.Println(status)
	fmt.Println("输入 help 查看命令。")
}

func runShell(state *shellState, scanner *bufio.Scanner) {
	for {
		currentShellSource = state.activeSource
		fmt.Print("audit> ")
		if !scanner.Scan() {
			fmt.Println()
			return
		}

		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		args := strings.Fields(line)
		command := strings.ToLower(args[0])

		switch command {
		case "help", "?":
			printHelp()
		case "status":
			printStatus(state)
		case "chains":
			if err := printChains(state); err != nil {
				fmt.Printf("chains failed: %v\n", err)
			}
		case "use-chain":
			if len(args) < 2 {
				fmt.Println("usage: use-chain <BSC|ETH|ARB|...>")
				continue
			}
			state.activeChain = strings.ToUpper(strings.TrimSpace(args[1]))
			if state.activeSource == dataSourceTokens {
				sortField, err := promptTokenSortField(scanner, state.activeChain)
				if err != nil {
					fmt.Printf("use-chain failed: %v\n", err)
					continue
				}
				state.tokenSortField = sortField
				stepValue, err := promptTokenStepValue(scanner, state, sortField)
				if err != nil {
					fmt.Printf("use-chain failed: %v\n", err)
					continue
				}
				state.tokenStepValues[sortField] = stepValue
			}
			fmt.Printf("activeChain=%s\n", state.activeChain)
		case "use-source":
			if len(args) == 1 {
				source, err := promptDataSource(scanner)
				if err != nil {
					fmt.Printf("use-source failed: %v\n", err)
					continue
				}
				state.activeSource = source
				currentShellSource = source
				if source == dataSourceTokens {
					sortField, err := promptTokenSortField(scanner, state.activeChain)
					if err != nil {
						fmt.Printf("use-source failed: %v\n", err)
						continue
					}
					state.tokenSortField = sortField
					stepValue, err := promptTokenStepValue(scanner, state, sortField)
					if err != nil {
						fmt.Printf("use-source failed: %v\n", err)
						continue
					}
					state.tokenStepValues[sortField] = stepValue
				}
				fmt.Printf("activeSource=%s\n", state.activeSource)
				continue
			}
			if len(args) != 2 {
				fmt.Println("usage: use-source [contracts|tokens]")
				continue
			}
			source, err := parseDataSource(args[1])
			if err != nil {
				fmt.Printf("use-source failed: %v\n", err)
				continue
			}
			state.activeSource = source
			currentShellSource = source
			if source == dataSourceTokens {
				sortField, err := promptTokenSortField(scanner, state.activeChain)
				if err != nil {
					fmt.Printf("use-source failed: %v\n", err)
					continue
				}
				state.tokenSortField = sortField
				stepValue, err := promptTokenStepValue(scanner, state, sortField)
				if err != nil {
					fmt.Printf("use-source failed: %v\n", err)
					continue
				}
				state.tokenStepValues[sortField] = stepValue
			}
			fmt.Printf("activeSource=%s\n", state.activeSource)
		case "set-token-sort":
			if state.activeSource != dataSourceTokens {
				fmt.Println("set-token-sort is only available when source=tokens")
				continue
			}
			if len(args) == 1 {
				sortField, err := promptTokenSortField(scanner, state.activeChain)
				if err != nil {
					fmt.Printf("set-token-sort failed: %v\n", err)
					continue
				}
				state.tokenSortField = sortField
				stepValue, err := promptTokenStepValue(scanner, state, sortField)
				if err != nil {
					fmt.Printf("set-token-sort failed: %v\n", err)
					continue
				}
				state.tokenStepValues[sortField] = stepValue
				printStatus(state)
				continue
			}
			if len(args) != 2 {
				fmt.Println("usage: set-token-sort [field]")
				continue
			}
			sortField, err := normalizeTokenSortField(state.activeChain, args[1])
			if err != nil {
				fmt.Printf("set-token-sort failed: %v\n", err)
				continue
			}
			state.tokenSortField = sortField
			stepValue, err := promptTokenStepValue(scanner, state, sortField)
			if err != nil {
				fmt.Printf("set-token-sort failed: %v\n", err)
				continue
			}
			state.tokenStepValues[sortField] = stepValue
			printStatus(state)
		case "set-token-step":
			if state.activeSource != dataSourceTokens {
				fmt.Println("set-token-step is only available when source=tokens")
				continue
			}
			if len(args) == 1 {
				stepValue, err := promptTokenStepValue(scanner, state, state.tokenSortField)
				if err != nil {
					fmt.Printf("set-token-step failed: %v\n", err)
					continue
				}
				state.tokenStepValues[state.tokenSortField] = stepValue
				printStatus(state)
				continue
			}
			if len(args) != 2 {
				fmt.Println("usage: set-token-step [value]")
				continue
			}
			stepValue, err := strconv.ParseFloat(args[1], 64)
			if err != nil || stepValue <= 0 {
				fmt.Println("set-token-step failed: value must be a positive number")
				continue
			}
			state.tokenStepValues[state.tokenSortField] = stepValue
			printStatus(state)
		case "list":
			limit, minValue, err := parseListArgs(args[1:], state)
			if err != nil {
				fmt.Printf("list args error: %v\n", err)
				continue
			}
			if err := printContracts(state, minValue, limit); err != nil {
				fmt.Printf("list failed: %v\n", err)
			}
		case "scan":
			if len(args) < 2 {
				fmt.Println("usage: scan <contractAddress> [priority]")
				continue
			}
			priority := 0
			if len(args) >= 3 {
				value, err := strconv.Atoi(args[2])
				if err != nil {
					fmt.Printf("invalid priority: %v\n", err)
					continue
				}
				priority = value
			}
			if err := scanSingle(state, args[1], priority); err != nil {
				fmt.Printf("scan failed: %v\n", err)
			}
		case "delete":
			if len(args) != 2 {
				fmt.Println("usage: delete <contractAddress>")
				continue
			}
			if err := deleteSingle(state, args[1]); err != nil {
				fmt.Printf("delete failed: %v\n", err)
			}
		case "scan-batch":
			limit, minValue, sleepMS, err := parseBatchArgs(args[1:], state)
			if err != nil {
				fmt.Printf("scan-batch args error: %v\n", err)
				continue
			}
			if err := scanBatch(state, limit, minValue, sleepMS); err != nil {
				fmt.Printf("scan-batch failed: %v\n", err)
			}
		case "set-priority":
			if len(args) != 4 {
				fmt.Println("usage: set-priority <base> <stepValue> <max>")
				continue
			}
			base, err := strconv.Atoi(args[1])
			if err != nil {
				fmt.Printf("invalid base: %v\n", err)
				continue
			}
			stepValue, err := strconv.ParseFloat(args[2], 64)
			if err != nil {
				fmt.Printf("invalid stepValue: %v\n", err)
				continue
			}
			max, err := strconv.Atoi(args[3])
			if err != nil {
				fmt.Printf("invalid max: %v\n", err)
				continue
			}
			state.priorityBase = base
			state.priorityStepValue = stepValue
			state.priorityMax = max
			printStatus(state)
		case "set-min":
			if len(args) != 2 {
				fmt.Println("usage: set-min <value>")
				continue
			}
			value, err := strconv.ParseFloat(args[1], 64)
			if err != nil {
				fmt.Printf("invalid min value: %v\n", err)
				continue
			}
			state.minValue = value
			printStatus(state)
		case "set-limit":
			if len(args) != 2 {
				fmt.Println("usage: set-limit <n>")
				continue
			}
			value, err := strconv.Atoi(args[1])
			if err != nil {
				fmt.Printf("invalid limit: %v\n", err)
				continue
			}
			state.listLimit = value
			printStatus(state)
		case "set-sleep":
			if len(args) != 2 {
				fmt.Println("usage: set-sleep <ms>")
				continue
			}
			value, err := strconv.Atoi(args[1])
			if err != nil {
				fmt.Printf("invalid sleep: %v\n", err)
				continue
			}
			state.sleepMS = value
			printStatus(state)
		case "quit", "exit":
			return
		default:
			fmt.Printf("unknown command: %s\n", command)
		}
	}
}

func printHelp() {
	fmt.Println("commands:")
	fmt.Println("  help                              显示帮助")
	fmt.Println("  status                            查看当前 shell 状态")
	fmt.Println("  chains                            查看当前扫描源概况")
	fmt.Println("  use-chain <chain>                 切换当前链")
	fmt.Println("  use-source [contracts|tokens]     切换扫描源；不带参数时交互选择")
	fmt.Println("  set-token-sort [field]            设置 token 排序字段；不带参数时交互选择")
	fmt.Println("  set-token-step [value]            设置当前 token 排序字段的 step value；不带参数时交互输入")
	fmt.Println("  list [limit] [minValue]           查看当前链高价值目标，按 value 降序")
	fmt.Println("  scan <address> [priority]         扫描单个地址；不传 priority 时按 value 计算")
	fmt.Println("  delete <address>                  删除当前链该地址的服务端审计历史，并清理本地映射")
	fmt.Println("  scan-batch [limit] [minValue] [sleepMS]")
	fmt.Println("                                    批量扫描当前链高价值目标")
	fmt.Println("  set-priority <base> <stepValue> <max>")
	fmt.Println("                                    设置 priority 公式：价值越大，priority 数值越小")
	fmt.Println("  set-min <value>                   设置默认最小价值")
	fmt.Println("  set-limit <n>                     设置默认列表/批量 limit")
	fmt.Println("  set-sleep <ms>                    设置批量提交间隔")
	fmt.Println("  exit                              退出")
}

func printStatus(state *shellState) {
	status := fmt.Sprintf(
		"activeChain=%s source=%s minValue=%.4f listLimit=%d sleepMS=%d priorityBase=%d priorityStepValue=%.2f priorityMax=%d",
		state.activeChain,
		state.activeSource,
		state.minValue,
		state.listLimit,
		state.sleepMS,
		state.priorityBase,
		state.priorityStepValue,
		state.priorityMax,
	)
	if state.activeSource == dataSourceTokens {
		status += fmt.Sprintf(" tokenSort=%s tokenStepValue=%.2f", state.tokenSortField, currentPriorityStepValue(state))
	}
	if state.activeSource == dataSourceTokens && assetDataSource != "" {
		status += " assetDB=configured"
	}
	fmt.Println(status)
}

func printChains(state *shellState) error {
	if currentShellSource == dataSourceTokens {
		return printTokenChains(state)
	}

	summaries, err := loadChainSummaries()
	if err != nil {
		return err
	}
	if len(summaries) == 0 {
		fmt.Println("no valuable contracts found")
		return nil
	}

	sort.Slice(summaries, func(i, j int) bool {
		if summaries[i].TotalValue == summaries[j].TotalValue {
			return summaries[i].ChainName < summaries[j].ChainName
		}
		return summaries[i].TotalValue > summaries[j].TotalValue
	})

	writer := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(writer, "CHAIN\tCOUNT\tTOTAL_VALUE\tMAX_VALUE")
	for _, item := range summaries {
		fmt.Fprintf(writer, "%s\t%d\t%.6f\t%.6f\n", item.ChainName, item.Count, item.TotalValue, item.MaxValue)
	}
	return writer.Flush()
}

func printTokenChains(state *shellState) error {
	summaries, err := loadTokenChainSummaries(state.activeChain, state.tokenSortField)
	if err != nil {
		return err
	}
	if len(summaries) == 0 {
		fmt.Println("no valuable tokens found")
		return nil
	}

	sort.Slice(summaries, func(i, j int) bool {
		if summaries[i].TotalValue == summaries[j].TotalValue {
			return summaries[i].ChainName < summaries[j].ChainName
		}
		return summaries[i].TotalValue > summaries[j].TotalValue
	})

	writer := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(writer, "CHAIN\tSORT_FIELD\tCOUNT\tTOTAL_VALUE\tMAX_VALUE")
	for _, item := range summaries {
		fmt.Fprintf(writer, "%s\t%s\t%d\t%.6f\t%.6f\n", item.ChainName, state.tokenSortField, item.Count, item.TotalValue, item.MaxValue)
	}
	return writer.Flush()
}

func printContracts(state *shellState, minValue float64, limit int) error {
	if state.activeSource == dataSourceTokens {
		return printTokens(state, minValue, limit)
	}

	contracts, err := loadContracts(state.activeChain, minValue, limit)
	if err != nil {
		return err
	}
	if len(contracts) == 0 {
		fmt.Printf("no contracts found for chain=%s minValue=%.6f\n", state.activeChain, minValue)
		return nil
	}

	writer := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(writer, "INDEX\tCONTRACT\tCHAIN_ID\tVALUE\tPRIORITY")
	for index, item := range contracts {
		priority := computePriority(item.ContractValue, state.priorityBase, state.priorityStepValue, state.priorityMax)
		chainID := resolveChainID(item.ChainName, item.ChainID)
		fmt.Fprintf(writer, "%d\t%s\t%d\t%.6f\t%d\n", index+1, item.ContractAddress, chainID, item.ContractValue, priority)
	}
	return writer.Flush()
}

func printTokens(state *shellState, minValue float64, limit int) error {
	tokens, err := loadTokens(state.activeChain, state.tokenSortField, minValue, limit)
	if err != nil {
		return err
	}
	if len(tokens) == 0 {
		fmt.Printf("no tokens found for chain=%s minValue=%.6f\n", state.activeChain, minValue)
		return nil
	}

	writer := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(writer, "INDEX\tTOKEN\tSYMBOL\tCHAIN_ID\tVALUE\tPAIRS\tRISK\tPRIORITY")
	for index, item := range tokens {
		priority := computePriority(item.TokenValue, state.priorityBase, currentPriorityStepValue(state), state.priorityMax)
		chainID := resolveChainID(item.ChainName, item.ChainID)
		fmt.Fprintf(
			writer,
			"%d\t%s\t%s\t%d\t%.6f\t%d\t%d\t%d\n",
			index+1,
			item.TokenAddress,
			nullStringValue(item.Symbol),
			chainID,
			item.TokenValue,
			nullIntValue(item.PairsCount),
			nullIntValue(item.RiskLevel),
			priority,
		)
	}
	return writer.Flush()
}

func scanSingle(state *shellState, contractAddress string, priority int) error {
	if state.activeSource == dataSourceTokens {
		return scanSingleToken(state, contractAddress, priority)
	}

	item, err := loadContract(state.activeChain, contractAddress)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	chainName := strings.ToUpper(strings.TrimSpace(state.activeChain))
	chainID := resolveChainID(chainName, sql.NullInt64{})
	value := 0.0
	address := normalizeAddress(contractAddress)

	if item != nil {
		chainName = item.ChainName
		chainID = resolveChainID(item.ChainName, item.ChainID)
		value = item.ContractValue
		address = item.ContractAddress
	}

	if chainID == 0 {
		return fmt.Errorf("contract %s has no chain id", address)
	}

	if priority <= 0 {
		if item == nil {
			priority = state.priorityBase
		} else {
			priority = computePriority(item.ContractValue, state.priorityBase, state.priorityStepValue, state.priorityMax)
		}
	}

	if item == nil {
		log.Printf(
			"audit shell: scan contract=%s chain=%s value=unknown priority=%d source=manual",
			address,
			chainName,
			priority,
		)
		return audit.EnsureAuditWithPriority(chainID, chainName, address, priority)
	}

	log.Printf(
		"audit shell: scan contract=%s chain=%s value=%.6f priority=%d",
		address,
		chainName,
		value,
		priority,
	)
	return audit.EnsureAuditWithPriority(chainID, chainName, address, priority)
}

func scanSingleToken(state *shellState, tokenAddress string, priority int) error {
	item, err := loadToken(state.activeChain, state.tokenSortField, tokenAddress)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	chainName := strings.ToUpper(strings.TrimSpace(state.activeChain))
	chainID := resolveChainID(chainName, sql.NullInt64{})
	value := 0.0
	address := normalizeAddress(tokenAddress)

	if item != nil {
		chainName = item.ChainName
		chainID = resolveChainID(item.ChainName, item.ChainID)
		value = item.TokenValue
		address = item.TokenAddress
	}

	if chainID == 0 {
		return fmt.Errorf("token %s has no chain id", address)
	}

	if priority <= 0 {
		if item == nil {
			priority = state.priorityBase
		} else {
			priority = computePriority(item.TokenValue, state.priorityBase, currentPriorityStepValue(state), state.priorityMax)
		}
	}

	if item == nil {
		log.Printf(
			"audit shell: scan token=%s chain=%s value=unknown priority=%d source=manual",
			address,
			chainName,
			priority,
		)
		return audit.EnsureAuditWithPriority(chainID, chainName, address, priority)
	}

	log.Printf(
		"audit shell: scan token=%s chain=%s value=%.6f priority=%d",
		address,
		chainName,
		value,
		priority,
	)
	return audit.EnsureAuditWithPriority(chainID, chainName, address, priority)
}

func deleteSingle(state *shellState, contractAddress string) error {
	chainName := strings.ToUpper(strings.TrimSpace(state.activeChain))
	chainID := resolveChainID(chainName, sql.NullInt64{})
	if chainID == 0 {
		return fmt.Errorf("unknown chain id for active chain %s", chainName)
	}

	return audit.DeleteAuditHistory(chainID, chainName, contractAddress)
}

func scanBatch(state *shellState, limit int, minValue float64, sleepMS int) error {
	if state.activeSource == dataSourceTokens {
		return scanBatchTokens(state, limit, minValue, sleepMS)
	}

	contracts, err := loadContracts(state.activeChain, minValue, limit)
	if err != nil {
		return err
	}
	if len(contracts) == 0 {
		fmt.Printf("no contracts found for chain=%s minValue=%.6f\n", state.activeChain, minValue)
		return nil
	}

	processed := 0
	for index, item := range contracts {
		chainID := resolveChainID(item.ChainName, item.ChainID)
		if chainID == 0 {
			log.Printf("audit shell: [%d/%d] skip %s because chain id is empty", index+1, len(contracts), item.ContractAddress)
			continue
		}

		priority := computePriority(item.ContractValue, state.priorityBase, state.priorityStepValue, state.priorityMax)
		log.Printf(
			"audit shell: [%d/%d] submit contract=%s value=%.6f priority=%d",
			index+1,
			len(contracts),
			item.ContractAddress,
			item.ContractValue,
			priority,
		)

		if err := audit.EnsureAuditWithPriority(chainID, item.ChainName, item.ContractAddress, priority); err != nil {
			log.Printf("audit shell: submit failed contract=%s err=%v", item.ContractAddress, err)
			continue
		}

		processed++
		if sleepMS > 0 && index < len(contracts)-1 {
			time.Sleep(time.Duration(sleepMS) * time.Millisecond)
		}
	}

	fmt.Printf("batch finished total=%d processed=%d\n", len(contracts), processed)
	return nil
}

func scanBatchTokens(state *shellState, limit int, minValue float64, sleepMS int) error {
	tokens, err := loadTokens(state.activeChain, state.tokenSortField, minValue, limit)
	if err != nil {
		return err
	}
	if len(tokens) == 0 {
		fmt.Printf("no tokens found for chain=%s minValue=%.6f\n", state.activeChain, minValue)
		return nil
	}

	processed := 0
	for index, item := range tokens {
		chainID := resolveChainID(item.ChainName, item.ChainID)
		if chainID == 0 {
			log.Printf("audit shell: [%d/%d] skip token %s because chain id is empty", index+1, len(tokens), item.TokenAddress)
			continue
		}

		priority := computePriority(item.TokenValue, state.priorityBase, currentPriorityStepValue(state), state.priorityMax)
		log.Printf(
			"audit shell: [%d/%d] submit token=%s value=%.6f priority=%d",
			index+1,
			len(tokens),
			item.TokenAddress,
			item.TokenValue,
			priority,
		)

		if err := audit.EnsureAuditWithPriority(chainID, item.ChainName, item.TokenAddress, priority); err != nil {
			log.Printf("audit shell: submit failed token=%s err=%v", item.TokenAddress, err)
			continue
		}

		processed++
		if sleepMS > 0 && index < len(tokens)-1 {
			time.Sleep(time.Duration(sleepMS) * time.Millisecond)
		}
	}

	fmt.Printf("batch finished total=%d processed=%d\n", len(tokens), processed)
	return nil
}

func parseListArgs(args []string, state *shellState) (int, float64, error) {
	limit := state.listLimit
	minValue := state.minValue
	if len(args) >= 1 {
		value, err := strconv.Atoi(args[0])
		if err != nil {
			return 0, 0, err
		}
		limit = value
	}
	if len(args) >= 2 {
		value, err := strconv.ParseFloat(args[1], 64)
		if err != nil {
			return 0, 0, err
		}
		minValue = value
	}
	return limit, minValue, nil
}

func parseBatchArgs(args []string, state *shellState) (int, float64, int, error) {
	limit := state.listLimit
	minValue := state.minValue
	sleepMS := state.sleepMS
	if len(args) >= 1 {
		value, err := strconv.Atoi(args[0])
		if err != nil {
			return 0, 0, 0, err
		}
		limit = value
	}
	if len(args) >= 2 {
		value, err := strconv.ParseFloat(args[1], 64)
		if err != nil {
			return 0, 0, 0, err
		}
		minValue = value
	}
	if len(args) >= 3 {
		value, err := strconv.Atoi(args[2])
		if err != nil {
			return 0, 0, 0, err
		}
		sleepMS = value
	}
	return limit, minValue, sleepMS, nil
}

func loadChainSummaries() ([]chainSummary, error) {
	query := `SELECT chain_name, COUNT(*), COALESCE(SUM(contract_value), 0), COALESCE(MAX(contract_value), 0)
FROM new_contracts
WHERE contract_value > 0
GROUP BY chain_name`

	rows, err := database.Primary.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	summaries := make([]chainSummary, 0)
	for rows.Next() {
		var item chainSummary
		if err := rows.Scan(&item.ChainName, &item.Count, &item.TotalValue, &item.MaxValue); err != nil {
			return nil, err
		}
		summaries = append(summaries, item)
	}

	return summaries, rows.Err()
}

func loadTokenChainSummaries(chainName, sortField string) ([]chainSummary, error) {
	resolvedChainName, err := resolveTokenChainName(chainName)
	if err != nil {
		return nil, err
	}
	sortField, err = normalizeTokenSortField(chainName, sortField)
	if err != nil {
		return nil, err
	}
	sortSQL, err := tokenSortExpression(sortField, resolvedChainName)
	if err != nil {
		return nil, err
	}
	db, err := ensureAssetMYSQL()
	if err != nil {
		return nil, err
	}

	query := fmt.Sprintf(`SELECT tl.chain_name, COUNT(*), COALESCE(SUM(%s), 0), COALESCE(MAX(%s), 0)
FROM token_liquidity tl
%s
WHERE tl.chain_name = ?
  AND %s > 0
GROUP BY tl.chain_name`, sortSQL.ValueExpr, sortSQL.ValueExpr, sortSQL.JoinSQL, sortSQL.ValueExpr)

	args := append([]interface{}{}, sortSQL.JoinArgs...)
	args = append(args, resolvedChainName)
	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	summaries := make([]chainSummary, 0)
	for rows.Next() {
		var item chainSummary
		if err := rows.Scan(&item.ChainName, &item.Count, &item.TotalValue, &item.MaxValue); err != nil {
			return nil, err
		}
		if item.ChainName == "" {
			item.ChainName = resolvedChainName
		}
		summaries = append(summaries, item)
	}

	return summaries, rows.Err()
}

func loadContracts(chainName string, minValue float64, limit int) ([]contractRow, error) {
	query := `SELECT id, contract_address, chain_id, chain_name, contract_value
FROM new_contracts
WHERE chain_name = ?
  AND contract_value > ?
ORDER BY contract_value DESC, id ASC`

	args := []interface{}{strings.ToUpper(strings.TrimSpace(chainName)), minValue}
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}

	rows, err := database.Primary.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	contracts := make([]contractRow, 0)
	for rows.Next() {
		var item contractRow
		if err := rows.Scan(&item.ID, &item.ContractAddress, &item.ChainID, &item.ChainName, &item.ContractValue); err != nil {
			return nil, err
		}
		contracts = append(contracts, item)
	}

	return contracts, rows.Err()
}

func loadTokens(chainName, sortField string, minValue float64, limit int) ([]tokenRow, error) {
	resolvedChainName, err := resolveTokenChainName(chainName)
	if err != nil {
		return nil, err
	}
	sortField, err = normalizeTokenSortField(chainName, sortField)
	if err != nil {
		return nil, err
	}
	sortSQL, err := tokenSortExpression(sortField, resolvedChainName)
	if err != nil {
		return nil, err
	}
	db, err := ensureAssetMYSQL()
	if err != nil {
		return nil, err
	}

	query := fmt.Sprintf(`SELECT tl.id, tl.token_address, tl.chain_id, tl.chain_name, tl.symbol, %s AS token_value, tl.risk_level, tl.pairs_count
FROM token_liquidity tl
%s
WHERE tl.chain_name = ?
  AND %s > ?
ORDER BY %s DESC, tl.id ASC`, sortSQL.ValueExpr, sortSQL.JoinSQL, sortSQL.ValueExpr, sortSQL.ValueExpr)

	args := append([]interface{}{}, sortSQL.JoinArgs...)
	args = append(args, resolvedChainName, minValue)
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tokens := make([]tokenRow, 0)
	for rows.Next() {
		var item tokenRow
		if err := rows.Scan(
			&item.ID,
			&item.TokenAddress,
			&item.ChainID,
			&item.ChainName,
			&item.Symbol,
			&item.TokenValue,
			&item.RiskLevel,
			&item.PairsCount,
		); err != nil {
			return nil, err
		}
		tokens = append(tokens, item)
	}

	return tokens, rows.Err()
}

func loadContract(chainName, contractAddress string) (*contractRow, error) {
	query := `SELECT id, contract_address, chain_id, chain_name, contract_value
FROM new_contracts
WHERE chain_name = ?
  AND LOWER(contract_address) = ?
LIMIT 1`

	row := database.Primary.QueryRow(query, strings.ToUpper(strings.TrimSpace(chainName)), normalizeAddress(contractAddress))
	var item contractRow
	if err := row.Scan(&item.ID, &item.ContractAddress, &item.ChainID, &item.ChainName, &item.ContractValue); err != nil {
		return nil, err
	}
	return &item, nil
}

func loadToken(chainName, sortField, tokenAddress string) (*tokenRow, error) {
	resolvedChainName, err := resolveTokenChainName(chainName)
	if err != nil {
		return nil, err
	}
	sortField, err = normalizeTokenSortField(chainName, sortField)
	if err != nil {
		return nil, err
	}
	sortSQL, err := tokenSortExpression(sortField, resolvedChainName)
	if err != nil {
		return nil, err
	}
	db, err := ensureAssetMYSQL()
	if err != nil {
		return nil, err
	}

	query := fmt.Sprintf(`SELECT tl.id, tl.token_address, tl.chain_id, tl.chain_name, tl.symbol, %s AS token_value, tl.risk_level, tl.pairs_count
FROM token_liquidity tl
%s
WHERE tl.chain_name = ?
  AND LOWER(tl.token_address) = ?
LIMIT 1`, sortSQL.ValueExpr, sortSQL.JoinSQL)

	args := append([]interface{}{}, sortSQL.JoinArgs...)
	args = append(args, resolvedChainName, normalizeAddress(tokenAddress))
	row := db.QueryRow(query, args...)
	var item tokenRow
	if err := row.Scan(
		&item.ID,
		&item.TokenAddress,
		&item.ChainID,
		&item.ChainName,
		&item.Symbol,
		&item.TokenValue,
		&item.RiskLevel,
		&item.PairsCount,
	); err != nil {
		return nil, err
	}
	return &item, nil
}

func resolveTokenChainName(chainName string) (string, error) {
	chainName = strings.ToUpper(strings.TrimSpace(chainName))
	if chainName == "" {
		return "", fmt.Errorf("token chain is empty")
	}
	if resolveChainID(chainName, sql.NullInt64{}) == 0 {
		return "", fmt.Errorf("token source is not configured for chain %s", chainName)
	}
	return chainName, nil
}

func parseDataSource(value string) (dataSource, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case string(dataSourceContracts), "contract":
		return dataSourceContracts, nil
	case string(dataSourceTokens), "token":
		return dataSourceTokens, nil
	default:
		return "", fmt.Errorf("unsupported source %q", value)
	}
}

func interactiveSetup(state *shellState, scanner *bufio.Scanner) error {
	source, err := promptDataSource(scanner)
	if err != nil {
		return err
	}
	state.activeSource = source
	currentShellSource = source
	if source == dataSourceTokens {
		sortField, err := promptTokenSortField(scanner, state.activeChain)
		if err != nil {
			return err
		}
		state.tokenSortField = sortField
		stepValue, err := promptTokenStepValue(scanner, state, sortField)
		if err != nil {
			return err
		}
		state.tokenStepValues[sortField] = stepValue
	}
	return nil
}

func promptDataSource(scanner *bufio.Scanner) (dataSource, error) {
	for {
		fmt.Println("请选择扫描源: contracts / tokens")
		fmt.Print("source> ")
		if !scanner.Scan() {
			return "", fmt.Errorf("input closed")
		}
		source, err := parseDataSource(scanner.Text())
		if err != nil {
			fmt.Printf("invalid source: %v\n", err)
			continue
		}
		return source, nil
	}
}

func promptTokenSortField(scanner *bufio.Scanner, chainName string) (string, error) {
	options, err := tokenSortOptions(chainName)
	if err != nil {
		return "", err
	}
	for {
		fmt.Printf("请选择 %s token 排序字段: %s\n", strings.ToUpper(strings.TrimSpace(chainName)), strings.Join(options, " / "))
		fmt.Print("token-sort> ")
		if !scanner.Scan() {
			return "", fmt.Errorf("input closed")
		}
		sortField, err := normalizeTokenSortField(chainName, scanner.Text())
		if err != nil {
			fmt.Printf("invalid token sort field: %v\n", err)
			continue
		}
		return sortField, nil
	}
}

func promptTokenStepValue(scanner *bufio.Scanner, state *shellState, sortField string) (float64, error) {
	current := state.priorityStepValue
	if state.tokenStepValues != nil {
		if configured, ok := state.tokenStepValues[sortField]; ok && configured > 0 {
			current = configured
		}
	}

	for {
		fmt.Printf("请设置 %s 的 step value（当前 %.2f，必须为正数）\n", sortField, current)
		fmt.Print("token-step> ")
		if !scanner.Scan() {
			return 0, fmt.Errorf("input closed")
		}
		text := strings.TrimSpace(scanner.Text())
		if text == "" {
			return current, nil
		}
		value, err := strconv.ParseFloat(text, 64)
		if err != nil || value <= 0 {
			fmt.Println("invalid token step value: must be a positive number")
			continue
		}
		return value, nil
	}
}

func defaultTokenSortField(chainName string) string {
	if len(quoteAssetAddresses(chainName)) > 0 {
		return "quote_pair_tvl_usd"
	}
	return "main_pair_tvl"
}

func tokenSortOptions(chainName string) ([]string, error) {
	if _, err := resolveTokenChainName(chainName); err != nil {
		return nil, err
	}
	options := []string{"main_pair_tvl", "holders", "current_price_usd", "price_change", "pairs_count"}
	if len(quoteAssetAddresses(chainName)) > 0 {
		options = append([]string{"quote_pair_tvl_usd"}, options...)
	}
	return options, nil
}

func normalizeTokenSortField(chainName, value string) (string, error) {
	options, err := tokenSortOptions(chainName)
	if err != nil {
		return "", err
	}
	value = strings.ToLower(strings.TrimSpace(value))
	switch value {
	case "", "quote", "quote-tvl", "quote_pair_tvl", "quote-pair-tvl", "quote-pair-tvl-usd", "trusted-tvl", "trusted_pair_tvl":
		value = defaultTokenSortField(chainName)
	case "main", "main-tvl", "tvl", "value", "main-pair-tvl", "mainpairtvl":
		value = "main_pair_tvl"
	case "price", "price_usd", "current-price-usd":
		value = "current_price_usd"
	case "change", "price-change":
		value = "price_change"
	case "pairs", "pair_count", "pair-count":
		value = "pairs_count"
	}
	for _, option := range options {
		if value == option {
			return option, nil
		}
	}
	return "", fmt.Errorf("unsupported sort field %q for chain %s", value, strings.ToUpper(strings.TrimSpace(chainName)))
}

func tokenSortExpression(sortField, chainName string) (tokenSortSQL, error) {
	switch strings.ToLower(strings.TrimSpace(sortField)) {
	case "quote_pair_tvl_usd":
		quoteAddresses := quoteAssetAddresses(chainName)
		if len(quoteAddresses) == 0 {
			return tokenSortSQL{}, fmt.Errorf("quote_pair_tvl_usd is not configured for chain %s", chainName)
		}
		placeholders := strings.TrimRight(strings.Repeat("?,", len(quoteAddresses)), ",")
		joinArgs := make([]interface{}, 0, 1+len(quoteAddresses)*4)
		for _, address := range quoteAddresses {
			joinArgs = append(joinArgs, address)
		}
		for _, address := range quoteAddresses {
			joinArgs = append(joinArgs, address)
		}
		joinArgs = append(joinArgs, strings.ToUpper(strings.TrimSpace(chainName)))
		for _, address := range quoteAddresses {
			joinArgs = append(joinArgs, address)
		}
		for _, address := range quoteAddresses {
			joinArgs = append(joinArgs, address)
		}
		return tokenSortSQL{
			ValueExpr: "COALESCE(q.quote_pair_tvl_usd, 0)",
			JoinArgs:  joinArgs,
			JoinSQL: fmt.Sprintf(`JOIN (
  SELECT chain_id, token_address,
         SUM(CASE
           WHEN token0_address IN (%s) THEN COALESCE(reserve0, 0) * COALESCE(token0_price_usd, 0) * 2
           WHEN token1_address IN (%s) THEN COALESCE(reserve1, 0) * COALESCE(token1_price_usd, 0) * 2
           ELSE 0
         END) AS quote_pair_tvl_usd
  FROM (
    SELECT chain_id, token_address, token0_address, token1_address, reserve0, reserve1, token0_price_usd, token1_price_usd
    FROM token_pairs FORCE INDEX (idx_token_pairs_tvl)
    WHERE chain_name = ?
      AND pair_tvl_usd > 0
  ) p
  WHERE token0_address IN (%s) OR token1_address IN (%s)
  GROUP BY chain_id, token_address
) q ON q.chain_id = tl.chain_id AND q.token_address = tl.token_address`, placeholders, placeholders, placeholders, placeholders),
		}, nil
	case "main_pair_tvl":
		return tokenSortSQL{ValueExpr: "COALESCE(tl.main_pair_tvl, 0)"}, nil
	case "holders":
		return tokenSortSQL{ValueExpr: "COALESCE(tl.holders, 0)"}, nil
	case "current_price_usd":
		return tokenSortSQL{ValueExpr: "COALESCE(tl.current_price_usd, 0)"}, nil
	case "price_change":
		return tokenSortSQL{ValueExpr: "COALESCE(tl.price_change, 0)"}, nil
	case "pairs_count":
		return tokenSortSQL{ValueExpr: "COALESCE(tl.pairs_count, 0)"}, nil
	default:
		return tokenSortSQL{}, fmt.Errorf("unsupported token sort field %q", sortField)
	}
}

func quoteAssetAddresses(chainName string) []string {
	switch strings.ToUpper(strings.TrimSpace(chainName)) {
	case "BSC":
		return []string{
			"0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
			"0x55d398326f99059ff775485246999027b3197955", // USDT
			"0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
			"0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
			"0xc5f0f7b66764f6ec8c8dff7ba683102295e16409", // FDUSD
			"0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3", // DAI
			"0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", // BTCB
			"0x2170ed0880ac9a755fd29b2688956bd959f933f8", // ETH
		}
	case "ETH":
		return []string{
			"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
			"0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
			"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
			"0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
			"0x853d955acef822db058eb8505911ed77f175b99e", // FRAX
			"0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
		}
	default:
		return nil
	}
}

func currentPriorityStepValue(state *shellState) float64 {
	if state.activeSource == dataSourceTokens && state.tokenSortField != "" && state.tokenStepValues != nil {
		if value, ok := state.tokenStepValues[state.tokenSortField]; ok && value > 0 {
			return value
		}
	}
	return state.priorityStepValue
}

func computePriority(value float64, base int, stepValue float64, max int) int {
	priority := max
	if priority <= 0 {
		priority = base
	}
	if stepValue > 0 {
		priority -= int(math.Floor(value / stepValue))
	}
	if base > 0 && priority < base {
		priority = base
	}
	if max > 0 && priority > max {
		priority = max
	}
	if priority < 1 {
		return 1
	}
	return priority
}

func resolveChainID(chainName string, chainID sql.NullInt64) int {
	if chainID.Valid && chainID.Int64 > 0 {
		return int(chainID.Int64)
	}

	switch strings.ToUpper(strings.TrimSpace(chainName)) {
	case "ETH":
		return 1
	case "BSC":
		return 56
	case "POLYGON":
		return 137
	case "ARB":
		return 42161
	case "OP":
		return 10
	default:
		return 0
	}
}

func normalizeAddress(address string) string {
	address = strings.TrimSpace(address)
	if strings.HasPrefix(address, "0x") || strings.HasPrefix(address, "0X") {
		return "0x" + strings.ToLower(address[2:])
	}
	return strings.ToLower(address)
}

func defaultAssetDataSource() string {
	if value := strings.TrimSpace(os.Getenv("ASSET_DB_DSN")); value != "" {
		return value
	}
	if value := strings.TrimSpace(os.Getenv("AVE_SCANNER_DSN")); value != "" {
		return value
	}
	return "ave_scanner:change_me@tcp(127.0.0.1:3307)/ave_scanner?parseTime=true"
}

func ensureAssetMYSQL() (*sql.DB, error) {
	if assetMYSQL != nil {
		return assetMYSQL, nil
	}
	if strings.TrimSpace(assetDataSource) == "" {
		return nil, fmt.Errorf("asset database DSN is empty")
	}

	db, err := sql.Open("mysql", assetDataSource)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(2)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}

	assetMYSQL = db
	log.Printf("audit shell: asset db connected")
	return assetMYSQL, nil
}

func nullStringValue(value sql.NullString) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func nullIntValue(value sql.NullInt64) int64 {
	if !value.Valid {
		return 0
	}
	return value.Int64
}

func closeMySQL() {
	if database.Primary != nil {
		if err := database.Primary.Close(); err != nil {
			fmt.Printf("close mysql failed: %v\n", err)
		}
	}
	if assetMYSQL != nil {
		if err := assetMYSQL.Close(); err != nil {
			fmt.Printf("close asset mysql failed: %v\n", err)
		}
	}
}

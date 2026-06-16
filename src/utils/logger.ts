enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

export interface LoggerConfig {
    name: string;
    minLevel: LogLevel;
    disabledLevels?: Set<LogLevel>;
}

export class Logger {
    private name: string;
    private minLevel: LogLevel;
    private disabledLevels: Set<LogLevel>;

    private static readonly LEVEL_TAG: Record<LogLevel, string> = {
        [LogLevel.DEBUG]: "DEBUG",
        [LogLevel.INFO]: "INFO",
        [LogLevel.WARN]: "WARN",
        [LogLevel.ERROR]: "ERROR"
    };

    private static readonly CONSOLE_METHOD: Record<LogLevel, (...args: unknown[]) => void> = {
        [LogLevel.DEBUG]: console.debug,
        [LogLevel.INFO]: console.log,
        [LogLevel.WARN]: console.warn,
        [LogLevel.ERROR]: console.error
    };

    constructor(config: LoggerConfig) {
        this.name = config.name;
        this.minLevel = config.minLevel;
        this.disabledLevels = config.disabledLevels ?? new Set();
    }

    public getMinLevel(): LogLevel {
        return this.minLevel;
    }

    public setMinLevel(level: LogLevel) {
        this.minLevel = level;
    }

    public disableLevel(level: LogLevel) {
        this.disabledLevels.add(level);
    }

    public enableLevel(level: LogLevel) {
        this.disabledLevels.delete(level);
    }

    public debug(...args: unknown[]): void {
        this.output(LogLevel.DEBUG, undefined, ...args);
    }

    public info(...args: unknown[]): void {
        this.output(LogLevel.INFO, undefined, ...args);
    }

    public warn(...args: unknown[]): void {
        this.output(LogLevel.WARN, undefined, ...args);
    }

    public error(...args: unknown[]): void {
        this.output(LogLevel.ERROR, undefined, ...args);
    }

    public debugWithPrefix(prefix: string, ...args: unknown[]): void {
        this.output(LogLevel.DEBUG, prefix, ...args);
    }
    public infoWithPrefix(prefix: string, ...args: unknown[]): void {
        this.output(LogLevel.INFO, prefix, ...args);
    }
    public warnWithPrefix(prefix: string, ...args: unknown[]): void {
        this.output(LogLevel.WARN, prefix, ...args);
    }
    /**
     * 打印变量名和值（debug 级别）
     * @param varObj - 包含变量的对象，例如 { myVariable }
     * @param extraPrefix - 可选临时前缀
     *
     * @example
     * const userName = "Alice";
     * logger.debugVar({ userName });   // 输出两行：
     * // [2025-...][App][DEBUG] variable: userName
     * // [2025-...][App][DEBUG] value:   Alice
     */
    public debugVar(varObj: Record<string, any>, extraPrefix?: string): void {
        const entries = Object.entries(varObj);
        if (entries.length === 0) return;

        for (const [key, value] of entries) {
            this.output(LogLevel.DEBUG, extraPrefix, `variable: ${key}`);
            this.output(LogLevel.DEBUG, extraPrefix, `value:   ${this.formatValue(value)}`);
        }
    }
    /**
     * 输出未知错误（通常用于 catch 块），级别 ERROR
     * @param err - 未知类型的错误对象
     * @param extraPrefix - 可选临时前缀
     * @param context - 可选额外上下文信息
     *
     * @example
     * try {
     *   riskyCall();
     * } catch (err) {
     *   logger.errorUnknown(err, "DB", { userId: 123 });
     * }
     */
    public errorUnknown(err: unknown, extraPrefix?: string, context?: Record<string, any>): void {
        let errorMessage: string;

        if (err instanceof Error) {
            errorMessage = `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`;
        } else if (typeof err === 'string') {
            errorMessage = err;
        } else {
            try {
                errorMessage = JSON.stringify(err);
            } catch {
                errorMessage = String(err);
            }
        }

        if (context) {
            errorMessage = `${errorMessage}\nContext: ${this.formatValue(context)}`;
        }

        this.output(LogLevel.ERROR, extraPrefix, errorMessage);
    }

    // 私有输出核心：统一处理级别过滤、前缀格式化、控制台输出
    private output(level: LogLevel, extraPrefix: string | undefined, ...args: unknown[]): void {
        if (level < this.minLevel) return;
        if (this.disabledLevels.has(level)) return;

        const timestamp = new Date().toISOString();
        const namePart = `[${this.name}]`;
        const extraPart = extraPrefix ? `[${extraPrefix}]` : "";
        const levelTag = Logger.LEVEL_TAG[level];
        const prefix = `${timestamp}${namePart}${extraPart}[${levelTag}]`;

        // 将前缀作为第一个参数传入，后续拼接原始消息参数
        Logger.CONSOLE_METHOD[level](prefix, ...args);
    }

    // 辅助方法：格式化值，便于调试输出
    private formatValue(value: unknown): string {
        if (typeof value === "string") return `"${value}"`;
        if (value === null) return "null";
        if (value === undefined) return "undefined";
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
}

export const logger = new Logger({
    name: "CNAplugin",
    minLevel: LogLevel.DEBUG,
})
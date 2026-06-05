enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

export interface LoggerConfig {
    minLevel: LogLevel;
    prefix?: string;
    disabledLevels?: Set<LogLevel>;
}

export class Logger {
    private minLevel: LogLevel;
    private prefix: string;
    private disabledLevels: Set<LogLevel>;
    private static readonly LEVEL_TAG: Record<LogLevel, string> = {
        [LogLevel.DEBUG]: "DEBUG",
        [LogLevel.INFO]: "INFO",
        [LogLevel.WARN]: "WARN",
        [LogLevel.ERROR]: "ERROR"
    };
    private static readonly CONSOLE_METHOD: Record<LogLevel, (...args:unknown[])=>void> = {
            [LogLevel.DEBUG]: console.debug,
            [LogLevel.INFO]: console.log,
            [LogLevel.WARN]: console.warn,
            [LogLevel.ERROR]: console.error
    };
    
    constructor(config: LoggerConfig) {
        this.minLevel = config.minLevel;
        this.prefix = config.prefix ?? "";
        this.disabledLevels = config.disabledLevels ?? new Set();
    }

    public getMinLevel(): LogLevel {
        return this.minLevel;
    }
    public getPrefix(): string {
        return this.prefix;
    }
    public setMinLevel(level: LogLevel) {
        this.minLevel = level;
    }
    public setPrefix(prefix: string) {
        this.prefix = prefix;
    }
    public disableLevel(level: LogLevel) {
        this.disabledLevels.add(level);
    }
    public enableLevel(level: LogLevel) {
        this.disabledLevels.delete(level) ;
    }

    public debug(...args: unknown[]): void {
        this.output(LogLevel.DEBUG, ...args);
    }
    public info(...args: unknown[]): void {
        this.output(LogLevel.INFO, ...args);
    }

    public warn(...args: unknown[]): void {
        this.output(LogLevel.WARN, ...args);
    }

    public error(...args: unknown[]): void {
        this.output(LogLevel.ERROR, ...args);
    }

    private output(level: LogLevel, ...args: unknown[]): void {
        if (level < this.minLevel) return;
        if (this.disabledLevels.has(level)) return;
        const levelTag = Logger.LEVEL_TAG[level];
        const timestamp = new Date().toISOString();
        const prefixFormatted = this.prefix ? `[${this.prefix}]` : "";
        Logger.CONSOLE_METHOD[level](`[${timestamp}]${prefixFormatted}[${levelTag}]`, ...args);
    }
}

export const logger = new Logger({ minLevel: LogLevel.DEBUG});

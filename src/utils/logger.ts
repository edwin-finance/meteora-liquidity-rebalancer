import { CloudWatchLogsClient, PutLogEventsCommand, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import * as fs from 'fs';
import * as path from 'path';
import { sendAlert, AlertType } from './alerts';

interface StorageBackend {
    append(content: string): Promise<void>;
    getLastNLines(n: number): Promise<string>;
    getLogsFromTimestamp(timestamp: string): Promise<string>;
}

class LocalFileStorage implements StorageBackend {
    private logFile: string;

    constructor() {
        this.logFile = path.join(process.cwd(), 'logs', 'balances.log');
        const logsDir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir);
        }
    }

    async append(content: string): Promise<void> {
        fs.appendFileSync(this.logFile, content);
    }

    async getLastNLines(n: number): Promise<string> {
        if (!fs.existsSync(this.logFile)) {
            return '';
        }
        const content = fs.readFileSync(this.logFile, 'utf-8');
        const lines = content.split('\n').filter((line) => line.trim().length > 0);
        return lines.slice(-n).join('\n');
    }

    async getLogsFromTimestamp(timestamp: string): Promise<string> {
        if (!fs.existsSync(this.logFile)) {
            return '';
        }
        const content = fs.readFileSync(this.logFile, 'utf-8');
        const targetDate = new Date(timestamp);

        return content
            .split('\n')
            .filter((line) => {
                if (line.trim().length === 0) return false;
                const logTimestamp = line.match(/\[(.*?)\]/)?.[1];
                if (!logTimestamp) return false;
                return new Date(logTimestamp) >= targetDate;
            })
            .join('\n');
    }
}

class CloudWatchStorage implements StorageBackend {
    private client: CloudWatchLogsClient;
    private logGroupName: string;
    private logStreamName: string;
    private sequenceToken: string | undefined;

    constructor() {
        this.client = new CloudWatchLogsClient({
            region: process.env.AWS_REGION!,
        });
        this.logGroupName = process.env.LOG_GROUP_NAME!;
        this.logStreamName = process.env.BALANCE_LOG_STREAM_NAME!;
    }

    async append(content: string): Promise<void> {
        try {
            const command = new PutLogEventsCommand({
                logGroupName: this.logGroupName,
                logStreamName: this.logStreamName,
                logEvents: [
                    {
                        timestamp: Date.now(),
                        message: content,
                    },
                ],
                sequenceToken: this.sequenceToken,
            });

            const response = await this.client.send(command);
            this.sequenceToken = response.nextSequenceToken;
        } catch (error) {
            console.error('Error writing to CloudWatch:', error);
            sendAlert(AlertType.ERROR, `Error on append: ${error}`);
            throw error;
        }
    }

    async getLastNLines(n: number): Promise<string> {
        try {
            const command = new GetLogEventsCommand({
                logGroupName: this.logGroupName,
                logStreamName: this.logStreamName,
                limit: n,
                startFromHead: false,
            });

            const response = await this.client.send(command);
            return (response.events || [])
                .reverse()
                .map((event) => event.message)
                .join('\n');
        } catch (error) {
            console.error('Error reading from CloudWatch:', error);
            sendAlert(AlertType.ERROR, `Error on getLastNLines: ${error}`);
            return '';
        }
    }

    async getLogsFromTimestamp(timestamp: string): Promise<string> {
        try {
            const targetDate = new Date(timestamp);
            const command = new GetLogEventsCommand({
                logGroupName: this.logGroupName,
                logStreamName: this.logStreamName,
                startTime: targetDate.getTime(),
                startFromHead: false,
            });

            const response = await this.client.send(command);
            return (response.events || []).map((event) => event.message).join('\n');
        } catch (error) {
            console.error('Error reading from CloudWatch:', error);
            sendAlert(AlertType.ERROR, `Error on getLogsFromTimestamp: ${error}`);
            return '';
        }
    }
}

export class BalanceLogger {
    private storage: StorageBackend;

    constructor() {
        const env = process.env.NODE_ENV || 'development';
        this.storage = env === 'development' ? new LocalFileStorage() : new CloudWatchStorage();
    }

    public async logTotalWorth(solBalance: number, usdcBalance: number, solPriceInUsdc: number) {
        const totalWorth = solBalance * solPriceInUsdc + usdcBalance;
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] Total worth: ${totalWorth} USDC\n`;
        await this.storage.append(logEntry);
    }

    public async logBalances(solBalance: number, usdcBalance: number, prefix: string) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${prefix}  -  SOL: ${solBalance}, USDC: ${usdcBalance}\n`;
        console.log(logEntry);
        await this.storage.append(logEntry);
    }

    public async logCurrentPrice(price: number) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] Current price: 1 SOL = ${price} USDC\n`;
        await this.storage.append(logEntry);
    }

    public async logAction(action: string) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${action}\n`;
        await this.storage.append(logEntry);
        console.log(logEntry);
    }

    public async getLastNLines(n: number): Promise<string> {
        console.log('Getting last N lines');
        return await this.storage.getLastNLines(n);
    }

    public async getLogsFromTimestamp(timestamp: string): Promise<string> {
        console.log('Getting logs from timestamp');
        return await this.storage.getLogsFromTimestamp(timestamp);
    }
}

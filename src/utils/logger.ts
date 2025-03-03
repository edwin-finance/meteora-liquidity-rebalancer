import {
    CloudWatchLogsClient,
    PutLogEventsCommand,
    GetLogEventsCommand,
    CreateLogStreamCommand,
} from '@aws-sdk/client-cloudwatch-logs';
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
        return content
            .split('\n')
            .filter((line) => {
                if (line.trim().length === 0) return false;
                const logTimestamp = line.match(/\[(.*?)\]/)?.[1];
                return logTimestamp && new Date(logTimestamp) >= new Date(timestamp);
            })
            .join('\n');
    }
}

class CloudWatchStorage implements StorageBackend {
    private client: CloudWatchLogsClient;
    private logGroupName: string;
    private logStreamName: string;

    constructor() {
        if (!process.env.AWS_REGION || !process.env.LOG_GROUP_NAME || !process.env.BALANCE_LOG_STREAM_NAME) {
            console.warn(
                'AWS_REGION, LOG_GROUP_NAME, or BALANCE_LOG_STREAM_NAME env variables are not set for CloudWatch logging'
            );
        }

        this.client = new CloudWatchLogsClient({
            region: process.env.AWS_REGION!,
        });
        this.logGroupName = process.env.LOG_GROUP_NAME!;
        this.logStreamName = process.env.BALANCE_LOG_STREAM_NAME!;

        // Try to create log stream if it doesn't exist
        this.createLogStreamIfNeeded().catch((e) => {
            console.error('Failed to create CloudWatch log stream:', e);
            sendAlert(AlertType.ERROR, `Failed to set up CloudWatch logging: ${e}`);
        });
    }

    private async createLogStreamIfNeeded() {
        try {
            const command = new CreateLogStreamCommand({
                logGroupName: this.logGroupName,
                logStreamName: this.logStreamName,
            });
            await this.client.send(command);
            console.log(`Created CloudWatch log stream: ${this.logStreamName}`);
        } catch (error: any) {
            // ResourceAlreadyExistsException is expected and not an error
            if (error.name === 'ResourceAlreadyExistsException') {
                console.log(`Using existing CloudWatch log stream: ${this.logStreamName}`);
            } else {
                console.error('Error creating CloudWatch log stream:', error);
            }
        }
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
            });
            await this.client.send(command);
        } catch (error) {
            console.error('Error writing to CloudWatch:', error);
            // Fall back to local file logging
            const localStorage = new LocalFileStorage();
            await localStorage.append(content);
        }
    }

    async getLastNLines(n: number): Promise<string> {
        try {
            const command = new GetLogEventsCommand({
                logGroupName: this.logGroupName,
                logStreamName: this.logStreamName,
                limit: n,
            });
            const response = await this.client.send(command);
            return (response.events || [])
                .map((event) => event.message)
                .filter((message): message is string => !!message)
                .join('\n');
        } catch (error) {
            console.error('Error reading from CloudWatch:', error);
            return '';
        }
    }

    async getLogsFromTimestamp(timestamp: string): Promise<string> {
        try {
            const startTime = new Date(timestamp).getTime();
            const command = new GetLogEventsCommand({
                logGroupName: this.logGroupName,
                logStreamName: this.logStreamName,
                startTime,
            });
            const response = await this.client.send(command);
            return (response.events || [])
                .map((event) => event.message)
                .filter((message): message is string => !!message)
                .join('\n');
        } catch (error) {
            console.error('Error reading from CloudWatch:', error);
            return '';
        }
    }
}

export class BalanceLogger {
    private storage: StorageBackend;

    constructor() {
        // Use the USE_CLOUD_WATCH_STORAGE env variable flag to determine storage backend
        const useCloudWatch = process.env.USE_CLOUD_WATCH_STORAGE === 'true';
        this.storage = useCloudWatch ? new CloudWatchStorage() : new LocalFileStorage();

        console.log(`Initialized BalanceLogger with ${useCloudWatch ? 'CloudWatch' : 'LocalFile'} storage backend`);
    }

    public async logBalances(
        assetABalance: number, 
        assetBBalance: number, 
        prefix: string, 
        assetASymbol: string = 'Asset A', 
        assetBSymbol: string = 'Asset B'
    ) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${prefix}  -  ${assetASymbol}: ${assetABalance}, ${assetBSymbol}: ${assetBBalance}\n`;
        console.log(logEntry);
        await this.storage.append(logEntry);
    }

    public async logCurrentPrice(
        price: number,
        assetASymbol: string = 'Asset A',
        assetBSymbol: string = 'Asset B'
    ) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] Current price: 1 ${assetASymbol} = ${price} ${assetBSymbol}\n`;
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

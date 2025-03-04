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
    getLastLogByPrefix(prefix: string, timestamp: Date): Promise<string | null>;
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

    async getLastLogByPrefix(prefix: string, timestamp: Date): Promise<string | null> {
        if (!fs.existsSync(this.logFile)) {
            return null;
        }

        const content = fs.readFileSync(this.logFile, 'utf-8');
        const lastLogLine = content
            .split('\n')
            .filter((line) => line.includes(prefix))
            .filter((line) => {
                const logTimestamp = line.match(/\[(.*?)\]/)?.[1];
                return logTimestamp && new Date(logTimestamp) <= timestamp;
            })
            .pop();

        return lastLogLine || null;
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
    }

    async getLastLogByPrefix(prefix: string, timestamp: Date): Promise<string | null> {
        const command = new GetLogEventsCommand({
            logGroupName: this.logGroupName,
            logStreamName: this.logStreamName,
            endTime: timestamp.getTime(),
            limit: 1000,
        });

        const response = await this.client.send(command);

        const matchingLogs = (response.events || [])
            .filter((event) => {
                const message = event.message || '';
                return message.includes(prefix) && (event.timestamp || 0) <= timestamp.getTime();
            })
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        return matchingLogs.length > 0 ? matchingLogs[0].message || null : null;
    }
}

export class BalanceLogger {
    private storage: StorageBackend;
    public static TOTAL_BALANCE_PREFIX = 'Total usable balances after rebalancing';

    constructor() {
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

    public async logCurrentPrice(price: number, assetASymbol: string = 'Asset A', assetBSymbol: string = 'Asset B') {
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

    private extractBalanceFromLog(logMessage: string): [number, number] | null {
        const match = logMessage.match(/(\w+): ([\d.]+), (\w+): ([\d.]+)/);
        if (match) {
            return [parseFloat(match[2]), parseFloat(match[4])];
        }
        return null;
    }

    public async getLastBalance(timestamp: Date = new Date()): Promise<[number, number] | null> {
        const logMessage = await this.storage.getLastLogByPrefix(BalanceLogger.TOTAL_BALANCE_PREFIX, timestamp);
        return logMessage ? this.extractBalanceFromLog(logMessage) : null;
    }
}

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
    getLastBalanceByPrefix(prefix: string, timestamp: Date): Promise<[number, number] | null>;
}

function extractBalanceFromLog(logMessage: string): [number, number] | null {
    const match = logMessage.match(/Asset A: ([\d.]+), Asset B: ([\d.]+)/);
    if (match) {
        return [parseFloat(match[1]), parseFloat(match[2])];
    }
    return null;
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

    async getLastBalanceByPrefix(prefix: string, timestamp: Date): Promise<[number, number] | null> {
        if (!fs.existsSync(this.logFile)) {
            return null;
        }

        const content = fs.readFileSync(this.logFile, 'utf-8');
        const lastBalanceLine = content
            .split('\n')
            .filter((line) => line.includes('Asset A:') && line.includes(prefix))
            .filter((line) => {
                const logTimestamp = line.match(/\[(.*?)\]/)?.[1];
                return logTimestamp && new Date(logTimestamp) <= timestamp;
            })
            .pop();

        return lastBalanceLine ? extractBalanceFromLog(lastBalanceLine) : null;
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
        const command = new CreateLogStreamCommand({
            logGroupName: this.logGroupName,
            logStreamName: this.logStreamName,
        });
        await this.client.send(command);
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

    async getLastBalanceByPrefix(prefix: string, timestamp: Date): Promise<[number, number] | null> {
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
                return (
                    message.includes('Asset A:') &&
                    message.includes(prefix) &&
                    (event.timestamp || 0) <= timestamp.getTime()
                );
            })
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        if (matchingLogs.length > 0 && matchingLogs[0].message) {
            return extractBalanceFromLog(matchingLogs[0].message);
        }

        return null;
    }
}

export class BalanceLogger {
    private storage: StorageBackend;

    constructor() {
        const useCloudWatch = process.env.USE_CLOUD_WATCH_STORAGE === 'true';
        this.storage = useCloudWatch ? new CloudWatchStorage() : new LocalFileStorage();
        console.log(`Initialized BalanceLogger with ${useCloudWatch ? 'CloudWatch' : 'LocalFile'} storage backend`);
    }

    public async logBalances(assetABalance: number, assetBBalance: number, prefix: string) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${prefix}  -  Asset A: ${assetABalance}, Asset B: ${assetBBalance}\n`;
        console.log(logEntry);
        await this.storage.append(logEntry);
    }

    public async logCurrentPrice(price: number) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] Current price: 1 Asset A = ${price} Asset B\n`;
        await this.storage.append(logEntry);
    }

    public async logAction(action: string) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${action}\n`;
        await this.storage.append(logEntry);
        console.log(logEntry);
    }

    public async getLastBalanceByPrefix(prefix: string, timestamp: Date = new Date()): Promise<[number, number] | null> {
        return await this.storage.getLastBalanceByPrefix(prefix, timestamp);
    }
}

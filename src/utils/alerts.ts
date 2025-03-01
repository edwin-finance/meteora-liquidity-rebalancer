import dotenv from 'dotenv';

dotenv.config();

export enum AlertType {
    LOSS = 'LOSS',
    PERFORMANCE_REPORT = 'PERFORMANCE_REPORT',
    ERROR = 'ERROR',
    WARNING = 'WARNING',
}

export async function sendAlert(type: AlertType, message: string) {
    console.warn(`[${type}] ${message}`);
}

export function checkLossThreshold(currentValue: number, previousValue?: number, threshold = -0.02): boolean {
    if (!previousValue) {
        return false;
    }
    const percentageChange = (currentValue - previousValue) / previousValue;
    if (percentageChange <= threshold) {
        sendAlert(
            AlertType.LOSS,
            `Value dropped by ${(percentageChange * 100).toFixed(2)}%\n` +
                `Previous: $${previousValue.toFixed(2)}\n` +
                `Current: $${currentValue.toFixed(2)}`
        );
        return true;
    }
    return false;
}

export function sendPerformanceReport(currentValue: number, previousValue: number) {
    const change = currentValue - previousValue;
    const percentChange = (change / previousValue) * 100;

    sendAlert(
        AlertType.PERFORMANCE_REPORT,
        `Performance Report:\n` +
            `Current Value: $${currentValue.toFixed(2)}\n` +
            `Change: ${change >= 0 ? '+' : ''}$${change.toFixed(2)} (${percentChange.toFixed(2)}%)`
    );
}

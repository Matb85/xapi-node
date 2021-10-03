import {AddTransaction, MessagesQueue, Transaction, Transactions} from '../interface/Interface';
import {Listener} from '../modules/Listener';
import {Time, Timer, Utils} from '..';
import {Log} from "../utils/Log";
import {ConnectionStatus, errorCode, Listeners, TransactionStatus, TransactionType} from '../enum/Enum';
import {WebSocketWrapper} from '../modules/WebSocketWrapper';
import {JsonError} from "logger4";

export class Queue extends Listener {
    private _status: ConnectionStatus = ConnectionStatus.DISCONNECTED;
    public get status() {
        return this._status;
    }

    public get loadCapacity() {
        const times = this.messagesElapsedTime.filter(i => i.elapsedMs() < 1500)
        if (times.length <= 4) {
            return times.length
        } else {
            return 5 + (1500 - times[times.length - 4].elapsedMs())
        }
    }

    public set status(status: ConnectionStatus) {
        if (this._status !== status) {
            this._status = status;
            this.callListener(Listeners.xapi_onConnectionChange, [status]);
        }
    }

    public transactions: Transactions = {};
    public lastReceivedMessage: Time | null = null;
    private type: TransactionType;
    private messageQueues: { urgent: MessagesQueue[], normal: MessagesQueue[] } = {urgent: [], normal: []};
    private _transactionIdIncrement: number = 0;
    private messagesElapsedTime: Time[] = [];
    public get _messagesElapsedTime() {
        return this.messagesElapsedTime
    }
    private messageSender: Timer = new Timer();
    private rateLimit: number;
    protected openTimeout: Timer = new Timer();
    protected WebSocket: WebSocketWrapper;

    public get queueSize() {
        return this.messageQueues.urgent.length + this.messageQueues.normal.length;
    }

    constructor(rateLimit: number, type: TransactionType) {
        super();
        this.rateLimit = rateLimit;
        this.type = type;
    }

    public stopTimer() {
        this.openTimeout.clear();
    }

    private addQueu(transaction: Transaction<any, any>): void {
        const {urgent, transactionId} = transaction;
        if (this.queueSize >= 150) {
            this.rejectTransaction({
                code: errorCode.XAPINODE_2,
                explain: 'messageQueues exceeded 150 size limit'
            }, transaction);
        } else {
            if (urgent) {
                this.messageQueues.urgent.push({transactionId});
            } else {
                this.messageQueues.normal.push({transactionId});
            }
            Log.print('debug', `${new Date().toISOString()}:${this.type === TransactionType.STREAM ? 'Stream' : 'Socket'};${transaction.transactionId};${transaction.command}; added to queue (messages in queue = ${this.queueSize})`);
        }
    }

    private addElapsedTime(time: Time) {
        if (this.messagesElapsedTime.length > 4) {
            this.messagesElapsedTime = [...this.messagesElapsedTime.slice(1, 5), time];
        } else {
            this.messagesElapsedTime.push(time);
        }
    }

    private isRateLimitReached() {
        return this.messagesElapsedTime.length < 4
            ? false
            : this.messagesElapsedTime[this.messagesElapsedTime.length - 4].elapsedMs() < this.rateLimit;
    }

    protected resetMessageTube() {
        if (this.queueSize > 0) {
            Log.info((this.type === TransactionType.STREAM ? 'Stream' : 'Socket')
                + '; Message queue reseted, deleted = ' + this.queueSize);
        }
        this.messageQueues = {urgent: [], normal: []};
        this.messagesElapsedTime = [];
        this.messageSender.clear();
    }

    public createTransactionId(): string {
        this._transactionIdIncrement += 1;
        if (this._transactionIdIncrement > 9999) {
            this._transactionIdIncrement = 0;
        }
        return Utils.getUTCTimestampString() + Utils.formatNumber(this._transactionIdIncrement, 4) + (this.type === TransactionType.SOCKET ? '0' : '1');
    }

    protected addTransaction(newTransaction: AddTransaction): Transaction<null, null> {
        return this.transactions[newTransaction.transactionId] = {
            command: newTransaction.command,
            type: this.type,
            request: {json: newTransaction.json, arguments: newTransaction.args, sent: null},
            response: {json: null, received: null, status: null},
            transactionId: newTransaction.transactionId,
            createdAt: new Time(),
            status: TransactionStatus.waiting,
            transactionPromise: {resolve: newTransaction.resolve, reject: newTransaction.reject},
            urgent: newTransaction.urgent,
            stack: newTransaction.stack,
        };
    }

    public rejectOldTransactions(): void {
        Object.values(this.transactions)
            .filter(t => t.transactionPromise.reject !== null && t.createdAt.elapsedMs() > 60000)
            .forEach(transaction => {
                this.rejectTransaction({
                    code: errorCode.XAPINODE_3,
                    explain: 'Timeout'
                }, transaction);
            });
    }

    public removeOldTransactions(): { removed: number } {
        let removed = 0;
        Object.values(this.transactions)
            .filter(t => t.transactionPromise.reject === null
                && t.transactionPromise.resolve === null
                && t.createdAt.elapsedMs() > 86400000)
            .forEach(transaction => {
                delete this.transactions[transaction.transactionId];
                removed += 1;
            });
        return {removed};
    }

    private sendJSON(json: string): Time | null {
        try {
            const time: Time = new Time();
            this.WebSocket.send(json);
            return time;
        } catch (e) {
            Log.error(e);
            return null;
        }
    }

    protected resolveTransaction(json: string, returnData: any, time: Time, transaction: Transaction<any, any>) {
        if (this.type === TransactionType.SOCKET) {
            transaction.response = {
                status: true,
                received: time,
                json: returnData
            };
        }

        transaction.status = TransactionStatus.successful;
        const {resolve} = transaction.transactionPromise;

        if (resolve !== null) {
            transaction.transactionPromise = {resolve: null, reject: null};
            if (transaction.type === TransactionType.STREAM) {
                Log.print('debug',`${new Date().toISOString()}: Stream (${transaction.transactionId}): ${transaction.command}, ${JSON.stringify(transaction.request.arguments)}`);
                resolve({transaction});
            } else if (transaction.request.sent !== null) {
                const elapsedMs = transaction.response.received !== null && transaction.response.received.getDifference(transaction.request.sent);
                Log.print('debug',`${new Date().toISOString()}: Socket (${transaction.transactionId}): ${transaction.command}, ${transaction.command === 'login' ? '(arguments contains secret information)' : JSON.stringify(transaction.request.arguments)}, (${elapsedMs}ms)`);
                resolve({returnData, time, json, transaction})
            }
        }

        if (transaction.command !== 'ping') {
            Log.print('debug', `${new Date().toISOString()}: Transaction archived:${Utils.transactionToJSONString(transaction)}`);
        }
    }

    protected rejectTransaction(
        json: { code: string, explain: string },
        transaction: Transaction<any, any>,
        interrupted: boolean = false,
        received: Time = new Time()
    ) {
        transaction.status = interrupted ? TransactionStatus.interrupted : TransactionStatus.timeout;
        transaction.response = {
            status: false,
            received,
            json
        };

        Log.print('debug', `${new Date().toISOString()}:${transaction.type} message rejected (${transaction.transactionId}): ${transaction.command}, ${transaction.command === 'login' ? '(arguments contains secret information)' : JSON.stringify(transaction.request.arguments)};Reason: ${JSON.stringify(json)}`);

        const {reject} = transaction.transactionPromise;

        if (reject !== null) {
            transaction.transactionPromise = {resolve: null, reject: null};
            const error = new JsonError('Transaction Rejected',{
                reason: json,
                transaction: transaction.command === 'login' ? Utils.hideSecretInfo(transaction) : transaction
            })
            error.stack = transaction.stack
            reject(error)
        }

        Log.print('debug', `${new Date().toISOString()}: Transaction archived:${Utils.transactionToJSONString(transaction)}`);
    }

    protected sendMessage(transaction: Transaction<any, any>, addQueu: boolean): boolean {
        if (!this.isRateLimitReached()) {
            if (this.queueSize === 0 || !addQueu) {
                const sentTime = this.sendJSON(transaction.request.json);
                if (sentTime !== null) {
                    this.addElapsedTime(sentTime);
                    transaction.request.sent = sentTime;
                    transaction.status = (transaction.type === TransactionType.STREAM)
                        ? TransactionStatus.successful
                        : TransactionStatus.sent;
                    if (transaction.type === TransactionType.STREAM) {
                        this.resolveTransaction('', null, new Time(), transaction);
                    }
                    return true;
                }
            }
        }

        if (addQueu) {
            this.addQueu(transaction);
        }

        if (this.queueSize > 0 && this.messageSender.isNull()) {
            this.callCleanQueuTimeout();
        }

        return false;
    }

    private callCleanQueuTimeout() {
        if (this.messagesElapsedTime.length <= 3) {
            this.tryCleanQueue();
        } else {
            const elapsedMs = this.messagesElapsedTime[this.messagesElapsedTime.length - 4].elapsedMs();
            const timeoutMs = Math.max(this.rateLimit - elapsedMs, 0);

            this.messageSender.setTimeout(() => {
                this.tryCleanQueue();
            }, timeoutMs);
        }
    }

    private tryCleanQueue() {
        while (this.queueSize > 0) {
            const urgent = this.messageQueues.urgent.length > 0;
            const {transactionId} = urgent ? this.messageQueues.urgent[0] : this.messageQueues.normal[0];
            if (this.transactions[transactionId].status === TransactionStatus.waiting) {
                const isSent = this.sendMessage(this.transactions[transactionId], false);
                if (!isSent) {
                    return;
                }
            }

            if (urgent) {
                this.messageQueues.urgent.shift();
            } else {
                this.messageQueues.normal.shift();
            }
        }
    }

    public isQueueContains(command: string) {
        return this.messageQueues.urgent.some(id => {
            return this.transactions[id.transactionId].command === command
        }) || this.messageQueues.normal.some(id => {
            return this.transactions[id.transactionId].command === command
        })
    }
}
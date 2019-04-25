import {Time} from "../modules/Time";

export interface Transactions {
	[transactionId: string]: Transaction<any>
}

export interface MessagesQueue {
	transactionId: string
}

export interface Transaction<T> {
	status: TransactionStatus,
	command: string
	createdAt: Time
	transactionId: string
	isStream: boolean
	request: {
		sent: Time,
		arguments: any
		json: any
	},
	response: {
		status: boolean
		received: Time
		json: any
	}
	promise: {
		resolve: null | ((resolve: { returnData: T, time: Time, transaction: Transaction<null>}) => void),
		reject: null | ((reject: { reason: { code: string, explain: string }, transaction: Transaction<null>}) => void)
	}
}

export enum TransactionStatus {
	waiting = 0,
	sent = 1,
	successful = 2,
	timeout = 3,
	interrupted = 4
}

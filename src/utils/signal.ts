export class Signal<T> {
    private promiseToComplete: Promise<T>;
    private promiseResolve!: (result: T) => void;
    private promiseReject!: (error: any) => void;

    constructor() {
        this.promiseToComplete = new Promise((resolve, reject) => {
            this.promiseResolve = resolve;
            this.promiseReject = reject;
        });
    }

    public complete(result: T): void {
        this.promiseResolve(result);
    }

    public completeVoid(this: Signal<void>) {
        this.promiseResolve(undefined);
    }

    public reject(error: Error): void {
        this.promiseReject(error);
    }

    public cancel(): void {
        this.promiseReject(new Error('The signal was cancelled.'));
    }

    public get promise(): Promise<T> {
        return this.promiseToComplete;
    }
}

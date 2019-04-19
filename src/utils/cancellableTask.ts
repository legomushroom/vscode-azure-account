import { Signal } from "./signal";
import { CancellationToken } from "vscode";
import { CancellationError } from "bluebird";

export class CancellableTask {
	private signal = new Signal();

	constructor(
		private task: () => Promise<any>,
		private cancellationToken: CancellationToken
	) {}

	public async run() {
		this.task()
			.then(this.signal.complete.bind(this.signal))
			.catch(this.signal.reject.bind(this.signal));
		
		this.cancellationToken.onCancellationRequested((e: any) => {
			this.signal.reject(new CancellationError(e));
		})

		return this.signal.promise;
	}
}
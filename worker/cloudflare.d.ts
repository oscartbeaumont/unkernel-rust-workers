declare module "cloudflare:workers" {
	export class DurableObject {
		protected constructor(ctx: DurableObjectState);
		protected ctx: DurableObjectState;
	}
}

interface DurableObjectState {
	waitUntil(promise: Promise<unknown>): void;
}

/** The subset of a Durable Object RPC stub used by this Worker. */
type DurableObjectRpcStub<T extends DurableObject> = {
	fetch(request: Request): Promise<Response>;
} & {
	[K in Exclude<keyof T, "fetch">]: T[K] extends (...args: infer A) => infer R
		? (...args: A) => Promise<Awaited<R>>
		: never;
};

interface DurableObjectNamespace<T extends DurableObject> {
	getByName(name: string): DurableObjectRpcStub<T>;
}

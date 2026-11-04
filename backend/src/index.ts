import { createApp } from './api/app.ts';
import { gateway } from './infrastructure/gateway.ts';
import { D1AuthStore } from './infrastructure/d1-store.ts';
import type { Bindings } from './infrastructure/bindings.ts';

export { RoomObject } from './infrastructure/room-object.ts';
const app = createApp(gateway);
export default {
	fetch: app.fetch,
	async scheduled(_event: ScheduledController, env: Bindings) {
		await new D1AuthStore(env.DB).cleanup();
	}
};

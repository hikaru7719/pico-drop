import { createApp } from './api/app.ts';
import { gateway } from './infrastructure/gateway.ts';
export { NearbyHub } from './infrastructure/nearby-hub.ts';
export default createApp(gateway);

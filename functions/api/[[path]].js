// Every /api/* request goes through the router in server/api.js.
import { handle } from '../../server/api.js';

export const onRequest = ({ request, env }) => handle(request, env);

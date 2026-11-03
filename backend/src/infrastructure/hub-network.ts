export interface HubNamespace<Id, Hub> {
	idFromName(name: string): Id;
	get(id: Id): Hub;
}

export function hubFor<Id, Hub>(env: { HUB: HubNamespace<Id, Hub> }, name: string) {
	return env.HUB.get(env.HUB.idFromName(name));
}

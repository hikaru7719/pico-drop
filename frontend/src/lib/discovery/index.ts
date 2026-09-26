import type { Location } from '../../../../shared/protocol.ts';
const INACCURATE =
	'位置情報の誤差が大きすぎます。場所を変えて再試行してください。';
const DENIED =
	'位置情報が許可されていません。ブラウザの設定で許可して再試行してください。';
const UNAVAILABLE = '位置情報を取得できませんでした。再試行してください。';
function readPosition(): Promise<GeolocationPosition> {
	return new Promise((resolve, reject) => {
		navigator.geolocation.getCurrentPosition(resolve, reject, {
			enableHighAccuracy: false,
			timeout: 15_000,
			maximumAge: 30_000
		});
	});
}
async function position() {
	try {
		return await readPosition();
	} catch (error) {
		throw new Error(
			(error as GeolocationPositionError).code === 1 ? DENIED : UNAVAILABLE
		);
	}
}
export async function locate(): Promise<Location> {
	if (!navigator.geolocation) {
		throw new Error('このブラウザでは位置情報を取得できません。');
	}
	const { coords } = await position();
	if (coords.accuracy > 10_000) {
		throw new Error(INACCURATE);
	}
	return coordinates(coords);
}

function coordinates({
	latitude,
	longitude,
	accuracy
}: GeolocationCoordinates) {
	return { latitude, longitude, accuracy };
}

import type { Location } from '../../../../shared/protocol.ts';
export function locate(): Promise<Location> {
	return new Promise((resolve, reject) => {
		if (!navigator.geolocation) {
			reject(new Error('このブラウザでは位置情報を取得できません。'));
			return;
		}
		navigator.geolocation.getCurrentPosition(
			({ coords }) => {
				if (coords.accuracy > 10_000) {
					reject(new Error('位置情報の誤差が大きすぎます。場所を変えて再試行してください。'));
					return;
				}
				resolve({
					latitude: coords.latitude,
					longitude: coords.longitude,
					accuracy: coords.accuracy
				});
			},
			(error) =>
				reject(
					new Error(
						error.code === 1
							? '位置情報が許可されていません。ブラウザの設定で許可して再試行してください。'
							: '位置情報を取得できませんでした。再試行してください。'
					)
				),
			{ enableHighAccuracy: false, timeout: 15_000, maximumAge: 30_000 }
		);
	});
}

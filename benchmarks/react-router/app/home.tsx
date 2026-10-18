import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { photos } from '../../data';

export default function Home() {
	const [ready, setReady] = useState(false);
	const [selected, setSelected] = useState(false);
	const [progress, setProgress] = useState(0);
	useEffect(() => {
		setReady(true);
	}, []);
	return (
		<main data-ready={ready}>
			<h1>Pico Drop</h1>
			<p>写真を選んで、相手に共有します。</p>
			<button
				disabled={!ready}
				onClick={() => setSelected(!selected)}
			>
				写真を選択
			</button>
			<ul>
				{selected &&
					photos.map((photo) => (
						<li key={photo.name}>
							<span>{photo.name}</span>
							<small>{photo.size}</small>
						</li>
					))}
			</ul>
			<button
				disabled={!ready}
				onClick={() => setProgress((value) => value + 1)}
			>
				進捗を更新
			</button>
			<progress
				value={progress}
				max={100}
			/>
			<output>{progress}</output>
			<Link
				to="/details"
				prefetch="none"
			>
				共有の説明
			</Link>
		</main>
	);
}

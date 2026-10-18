import { Link } from 'react-router';

export default function Details() {
	return (
		<main>
			<h1>共有の説明</h1>
			<p>共有リンクは10分間有効です。</p>
			<Link
				to="/"
				prefetch="none"
			>
				戻る
			</Link>
		</main>
	);
}

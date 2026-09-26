<script lang="ts">
	let { word }: { word: string } = $props();
</script>

<svg
	viewBox="0 0 64 64"
	fill="none"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#if word === 'さくら'}
		<g
			fill="#f5c1d0"
			stroke="#cf7896"
			stroke-width="1.3"
		>
			{#each [0, 72, 144, 216, 288] as angle}<path
					transform={`rotate(${angle} 32 32)`}
					d="M32 33C21 25 21 16 27 10L32 14L37 10C43 16 43 25 32 33Z"
				/>{/each}
		</g><circle
			cx="32"
			cy="32"
			r="5"
			fill="#e0ad50"
		/>
	{:else if word === 'りんご'}
		<path
			d="M32 22C21 13 9 21 12 37C14 51 23 56 32 51C41 56 50 51 52 37C55 21 43 13 32 22Z"
			fill="#e7867c"
			stroke="#b95e57"
			stroke-width="1.5"
		/>
		<path
			d="M32 22C31 15 34 10 37 8"
			stroke="#866c50"
			stroke-width="3"
		/><path
			d="M35 16C36 8 46 8 49 9C47 17 40 20 35 16Z"
			fill="#90ad78"
		/><path
			d="M21 27C18 30 18 35 19 38"
			stroke="#ffe9e2"
			stroke-width="3"
		/>
	{:else if word === 'いるか'}
		<path
			d="M9 37C14 22 25 15 39 20L43 14L46 23C50 25 54 29 57 34L47 33C44 43 35 48 25 45L20 51L15 45L8 48L13 39C22 42 30 37 32 32C22 30 16 35 9 37Z"
			fill="#8dbfce"
			stroke="#568caa"
			stroke-width="1.5"
		/>
		<path
			d="M32 33L27 43L39 38"
			fill="#6fa9c0"
		/><circle
			cx="44"
			cy="28"
			r="1.5"
			fill="#34536c"
		/>
	{:else if word === 'ひまわり'}
		<path
			d="M32 36V57M32 51C20 51 18 43 18 43C29 42 32 51 32 51ZM32 46C42 46 46 38 46 38C35 38 32 46 32 46Z"
			fill="#94b389"
			stroke="#7c9f70"
			stroke-width="2"
		/>
		<g fill="#edc76c"
			>{#each [0, 45, 90, 135, 180, 225, 270, 315] as angle}<ellipse
					transform={`rotate(${angle} 32 25)`}
					cx="32"
					cy="13"
					rx="5"
					ry="9"
				/>{/each}</g
		>
		<circle
			cx="32"
			cy="25"
			r="10"
			fill="#a98863"
		/><circle
			cx="32"
			cy="25"
			r="6"
			fill="#8d7054"
		/>
	{:else if word === 'うさぎ'}
		<g
			fill="#f4efe9"
			stroke="#b8aaa0"
			stroke-width="1.5"
			><ellipse
				cx="23"
				cy="22"
				rx="7"
				ry="17"
				transform="rotate(-12 23 22)"
			/><ellipse
				cx="41"
				cy="22"
				rx="7"
				ry="17"
				transform="rotate(12 41 22)"
			/><ellipse
				cx="32"
				cy="41"
				rx="21"
				ry="17"
			/></g
		>
		<path
			d="M22 13L25 28M42 13L39 28"
			stroke="#e4b2b5"
			stroke-width="5"
		/><circle
			cx="24"
			cy="39"
			r="2"
			fill="#6d635e"
		/><circle
			cx="40"
			cy="39"
			r="2"
			fill="#6d635e"
		/><path
			d="M29 45L32 48L35 45"
			fill="#d49c9e"
		/><path
			d="M32 48V51"
			stroke="#b8aaa0"
			stroke-width="1.5"
		/>
	{:else if word === 'ほし'}
		<path
			d="M32 7L40 23L58 26L45 39L48 57L32 48L16 57L19 39L6 26L24 23Z"
			fill="#efd080"
			stroke="#c9a455"
			stroke-width="1.5"
		/><path
			d="M32 16L27 28L15 30"
			stroke="#fff2cb"
			stroke-width="3"
		/>
	{:else if word === 'ぺんぎん'}
		<path
			d="M14 36L7 47L16 45M50 36L57 47L48 45"
			fill="#748798"
		/><ellipse
			cx="32"
			cy="34"
			rx="19"
			ry="25"
			fill="#748798"
		/><ellipse
			cx="32"
			cy="39"
			rx="14"
			ry="19"
			fill="#f2f3ee"
		/><circle
			cx="25"
			cy="27"
			r="2"
			fill="#364452"
		/><circle
			cx="39"
			cy="27"
			r="2"
			fill="#364452"
		/><path
			d="M28 33L32 38L36 33"
			fill="#dbb46d"
		/><path
			d="M21 56L17 60H28L27 56M37 56L36 60H47L43 56"
			fill="#dbb46d"
		/>
	{:else if word === 'にじ'}
		<path
			d="M9 45V34a23 23 0 0 1 46 0v11"
			stroke="#d99a95"
			stroke-width="6"
		/><path
			d="M15 45V34a17 17 0 0 1 34 0v11"
			stroke="#e6c981"
			stroke-width="6"
		/><path
			d="M21 45V34a11 11 0 0 1 22 0v11"
			stroke="#93b3a2"
			stroke-width="6"
		/><path
			d="M27 45V34a5 5 0 0 1 10 0v11"
			stroke="#9cbacf"
			stroke-width="6"
		/>
		<path
			d="M4 51C0 46 5 41 10 43C12 35 24 38 23 45C31 47 27 55 21 54H9C7 54 5 53 4 51ZM39 51C35 46 40 41 45 43C47 35 59 38 58 45C66 47 62 55 56 54H44C42 54 40 53 39 51Z"
			fill="#eef1f4"
			stroke="#c9d2db"
		/>
	{/if}
</svg>

<style>
	svg {
		display: block;
		width: 52px;
		height: 52px;
		flex-shrink: 0;
	}
</style>

<script lang="ts">
  let count = $state(0);
  let name = $state('');
</script>

<main><h1>Svelte Counter</h1>
  <button id="counter" onclick={() => count++}>Count: {count}</button>
  <label>Your name <input id="name" bind:value={name} /></label>
  <output id="greeting">{name}</output>
  <div id="indicator" style:width={`${20 + count}px`} style:height="12px" style:background-color="tomato"></div>
</main>

<script setup lang="ts">
import { ref } from "vue";
const count = ref(0);
const name = ref("");
</script>

<template>
  <main><h1>Vue Counter</h1>
    <button id="counter" @click="count++">Count: {{ count }}</button>
    <label>Your name <input id="name" v-model="name" /></label>
    <output id="greeting">{{ name }}</output>
    <div id="indicator" :style="{ width: `${20 + count}px`, height: '12px', backgroundColor: 'tomato' }" />
  </main>
</template>

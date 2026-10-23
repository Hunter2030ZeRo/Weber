import { mount, unmount } from 'svelte';
import { defineApp } from '@weber/runtime';
import App from './App.svelte';
import './style.css';

defineApp({ title: 'Svelte · Weber', mount(root) {
  const app = mount(App, { target: root });
  return () => { void unmount(app); };
} });

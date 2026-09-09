import { EventEmitter } from 'node:events';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface WindowOptions {
  width?: number; height?: number; title?: string; show?: boolean; allowedChannels?: string[];
}
export interface WebContents {
  executeJavaScript(source: string): Promise<Json>;
  getURL(): Promise<string>;
}
export interface WeberWindow extends EventEmitter {
  id?: number;
  ready: Promise<WeberWindow>;
  webContents: WebContents;
  loadFile(path: string): Promise<null>;
  loadURL(url: string): Promise<never>;
  setTitle(title: string): Promise<null>;
  show(): Promise<null>; hide(): Promise<null>; close(): Promise<null>;
}
export interface Application extends EventEmitter {
  whenReady(): Promise<void>; quit(): Promise<void>; dispose(): void;
}
export interface IpcMain {
  handle(channel: string, handler: (event: { sender: WebContents }, payload: Json) => Json | Promise<Json>): void;
  removeHandler(channel: string): void;
}
export interface WeberApplication {
  app: Application;
  BrowserWindow: new (options?: WindowOptions) => WeberWindow;
  ipcMain: IpcMain;
}
export function createApplication(options?: { hostPath?: string; hostArgs?: string[]; timeout?: number }): WeberApplication;
export const app: Application;
export const BrowserWindow: WeberApplication['BrowserWindow'];
export const ipcMain: IpcMain;

import { ApplicationRef, createComponent } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { defineApp } from '@weber/runtime';
import { AppComponent } from './app.component';
import './style.css';

defineApp({ title: 'Angular · Weber', mount(root) {
  const host = document.createElement('weber-angular-root');
  root.appendChild(host);
  let disposed = false;
  let app: ApplicationRef | undefined;
  // An explicit host prevents a late asynchronous bootstrap from selecting a
  // newer mount's element. Angular v21 uses zoneless change detection by default.
  void createApplication().then(created => {
    if (disposed) { created.destroy(); return; }
    app = created;
    const component = createComponent(AppComponent, { hostElement: host, environmentInjector: created.injector });
    created.attachView(component.hostView);
    component.changeDetectorRef.detectChanges();
  });
  return () => { disposed = true; app?.destroy(); host.remove(); };
} });

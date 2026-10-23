import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'weber-angular-root',
  imports: [FormsModule],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  readonly count = signal(0);
  readonly name = signal('');
  increment() { this.count.update(previous => previous + 1); }
}

use servo::{
    InputEvent, Key, KeyState, KeyboardEvent, MouseButtonAction, MouseButtonEvent, MouseMoveEvent,
    NamedKey, WebView, WheelDelta, WheelEvent, WheelMode,
};
use winit::{
    event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent},
    keyboard::{Key as WinitKey, ModifiersState, NamedKey as WinitNamedKey},
};

#[derive(Default)]
pub struct Input {
    point: servo::DevicePoint,
    modifiers: ModifiersState,
    composition: Composition,
}

impl Input {
    /// winit emits clear + commit in one Wayland done batch. Only a clear left
    /// without a commit cancels composition; it needs no recurring timer.
    pub fn finish_ime_batch(&mut self, view: &WebView) -> bool {
        let events = self.composition.finish();
        let changed = !events.is_empty();
        deliver_composition(view, events);
        changed
    }
    pub fn focus_lost(&mut self, view: &WebView) {
        self.finish_ime_batch(view);
        deliver_composition(view, self.composition.commit_on_blur());
    }
    pub fn forward(&mut self, view: &WebView, event: WindowEvent) {
        if !matches!(event, WindowEvent::Ime(_)) {
            self.finish_ime_batch(view);
        }
        let input = match event {
            WindowEvent::CursorMoved { position, .. } => {
                let position = position.cast::<f32>();
                self.point = servo::DevicePoint::new(position.x, position.y);
                InputEvent::MouseMove(MouseMoveEvent::new(self.point.into()))
            }
            WindowEvent::CursorLeft { .. } => InputEvent::MouseLeftViewport(Default::default()),
            WindowEvent::MouseInput { state, button, .. } => {
                let action = match state {
                    ElementState::Pressed => MouseButtonAction::Down,
                    ElementState::Released => MouseButtonAction::Up,
                };
                let button = match button {
                    MouseButton::Left => servo::MouseButton::Primary,
                    MouseButton::Right => servo::MouseButton::Secondary,
                    MouseButton::Middle => servo::MouseButton::Auxiliary,
                    MouseButton::Back => servo::MouseButton::Back,
                    MouseButton::Forward => servo::MouseButton::Forward,
                    MouseButton::Other(value) => servo::MouseButton::Other(value),
                };
                InputEvent::MouseButton(MouseButtonEvent::new(action, button, self.point.into()))
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let (x, y) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => (f64::from(x) * 76.0, f64::from(y) * 76.0),
                    MouseScrollDelta::PixelDelta(p) => (p.x, p.y),
                };
                InputEvent::Wheel(WheelEvent::new(
                    WheelDelta {
                        x,
                        y,
                        z: 0.0,
                        mode: WheelMode::DeltaPixel,
                    },
                    self.point.into(),
                ))
            }
            WindowEvent::ModifiersChanged(modifiers) => {
                self.modifiers = modifiers.state();
                return;
            }
            WindowEvent::KeyboardInput { event, .. } => {
                let state = match event.state {
                    ElementState::Pressed => KeyState::Down,
                    ElementState::Released => KeyState::Up,
                };
                let mut keyboard = KeyboardEvent::from_state_and_key(state, key(event.logical_key));
                keyboard.event.code = match event.physical_key {
                    winit::keyboard::PhysicalKey::Code(code) => format!("{code:?}")
                        .parse()
                        .unwrap_or(servo::Code::Unidentified),
                    winit::keyboard::PhysicalKey::Unidentified(_) => servo::Code::Unidentified,
                };
                keyboard.event.location = match event.location {
                    winit::keyboard::KeyLocation::Standard => servo::Location::Standard,
                    winit::keyboard::KeyLocation::Left => servo::Location::Left,
                    winit::keyboard::KeyLocation::Right => servo::Location::Right,
                    winit::keyboard::KeyLocation::Numpad => servo::Location::Numpad,
                };
                keyboard.event.is_composing = self.composition.active;
                keyboard.event.repeat = event.repeat;
                keyboard
                    .event
                    .modifiers
                    .set(servo::Modifiers::SHIFT, self.modifiers.shift_key());
                keyboard
                    .event
                    .modifiers
                    .set(servo::Modifiers::CONTROL, self.modifiers.control_key());
                keyboard
                    .event
                    .modifiers
                    .set(servo::Modifiers::ALT, self.modifiers.alt_key());
                keyboard
                    .event
                    .modifiers
                    .set(servo::Modifiers::META, self.modifiers.super_key());
                InputEvent::Keyboard(keyboard)
            }
            WindowEvent::Ime(ime) => {
                if let Ime::DeleteSurroundingText {
                    before_length,
                    after_length,
                    text,
                    cursor,
                    anchor,
                    replacement,
                } = ime
                {
                    if replacement.is_some() {
                        self.composition.active = false;
                        self.composition.clear_pending = false;
                    }
                    view.notify_input_event(InputEvent::Ime(
                        servo::ImeEvent::DeleteSurroundingText {
                            before_length,
                            after_length,
                            text,
                            cursor,
                            anchor,
                            replacement,
                        },
                    ));
                    return;
                }
                deliver_composition(view, self.composition.handle(ime));
                return;
            }
            _ => return,
        };
        view.notify_input_event(input);
    }
}

#[derive(Default)]
struct Composition {
    active: bool,
    clear_pending: bool,
    preedit: String,
}
fn composition(state: servo::CompositionState, data: String) -> servo::CompositionEvent {
    servo::CompositionEvent { state, data }
}
fn deliver_composition(view: &WebView, events: Vec<servo::CompositionEvent>) {
    for event in events {
        view.notify_input_event(InputEvent::Ime(servo::ImeEvent::Composition(event)));
    }
}
impl Composition {
    fn handle(&mut self, ime: Ime) -> Vec<servo::CompositionEvent> {
        use servo::CompositionState::{End, Start, Update};
        match ime {
            Ime::Enabled | Ime::DeleteSurroundingText { .. } => Vec::new(),
            Ime::Disabled => {
                // Backend context acknowledgement, never a request to blur DOM.
                self.active = false;
                self.clear_pending = false;
                self.preedit.clear();
                Vec::new()
            }
            Ime::Preedit(text, _) if text.is_empty() => {
                self.clear_pending = self.active;
                Vec::new()
            }
            Ime::Preedit(text, _) => {
                self.clear_pending = false;
                self.preedit.clone_from(&text);
                let mut events = Vec::with_capacity(2);
                if !self.active {
                    self.active = true;
                    events.push(composition(Start, String::new()));
                }
                events.push(composition(Update, text));
                events
            }
            Ime::Commit(text) => {
                let mut events = Vec::with_capacity(2);
                if self.clear_pending {
                    events.push(composition(Update, String::new()));
                }
                self.active = false;
                self.clear_pending = false;
                self.preedit.clear();
                events.push(composition(End, text));
                events
            }
        }
    }
    fn commit_on_blur(&mut self) -> Vec<servo::CompositionEvent> {
        if !std::mem::take(&mut self.active) {
            return Vec::new();
        }
        self.clear_pending = false;
        vec![composition(
            servo::CompositionState::End,
            std::mem::take(&mut self.preedit),
        )]
    }
    fn finish(&mut self) -> Vec<servo::CompositionEvent> {
        if !std::mem::take(&mut self.clear_pending) {
            return Vec::new();
        }
        self.active = false;
        self.preedit.clear();
        vec![
            composition(servo::CompositionState::Update, String::new()),
            composition(servo::CompositionState::End, String::new()),
        ]
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_focus_loss_commits_the_existing_preedit_once() {
        let mut ime = Composition::default();
        ime.handle(Ime::Preedit("나".into(), None));
        let events = ime.commit_on_blur();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0].state, servo::CompositionState::End));
        assert_eq!(events[0].data, "나");
        assert!(ime.commit_on_blur().is_empty());
        assert!(!ime.active);
    }
    #[test]
    fn surrounding_context_keeps_utf8_boundaries_and_the_full_selection() {
        let text = "🙂한".repeat(900);
        let context = servo::ImeSurroundingText::new(&text, 3500, 3507).unwrap();
        assert!(context.text.len() <= 4000);
        assert!(context.text.is_char_boundary(context.cursor));
        assert!(context.text.is_char_boundary(context.anchor));
        assert_eq!(&context.text[context.cursor..context.anchor], "🙂한");
        assert!(servo::ImeSurroundingText::new(&text, 1, 1).is_none());
        assert!(servo::ImeSurroundingText::new(&text, 0, text.len()).is_none());
        assert!(servo::ImeSurroundingText::new("a\0b", 1, 1).is_none());
        assert_eq!(servo::ImeSurroundingText::new("", 0, 0).unwrap().text, "");
    }
    #[test]
    fn ime_clear_and_commit_share_one_composition() {
        let mut ime = Composition::default();
        assert_eq!(ime.handle(Ime::Preedit("한".into(), Some((3, 3)))).len(), 2);
        assert!(ime.handle(Ime::Preedit(String::new(), None)).is_empty());
        let end = ime.handle(Ime::Commit("한".into()));
        assert!(matches!(end[0].state, servo::CompositionState::Update));
        assert!(end[0].data.is_empty());
        assert!(matches!(end[1].state, servo::CompositionState::End));
        assert_eq!(end[1].data, "한");
        assert!(ime.finish().is_empty());
        assert!(!ime.active);
    }
    #[test]
    fn deleting_final_jamo_finishes_without_leaving_composing_state() {
        let mut ime = Composition::default();
        ime.handle(Ime::Preedit("ㄱ".into(), Some((3, 3))));
        ime.handle(Ime::Preedit(String::new(), None));
        let canceled = ime.finish();
        assert_eq!(canceled.len(), 2);
        assert!(canceled.iter().all(|event| event.data.is_empty()));
        assert!(!ime.active);
        assert!(ime.finish().is_empty());
        assert!(matches!(
            ime.handle(Ime::Preedit("ㄴ".into(), None))[0].state,
            servo::CompositionState::Start
        ));
    }
    #[test]
    fn disabling_backend_does_not_request_dom_focus_dismissal() {
        let mut ime = Composition::default();
        ime.handle(Ime::Preedit("가".into(), None));
        assert!(ime.handle(Ime::Disabled).is_empty());
        assert!(!ime.active);
        assert!(ime.finish().is_empty());
    }
}

fn key(key: WinitKey) -> Key {
    let named = match key {
        WinitKey::Character(text) => return Key::Character(text.to_string()),
        WinitKey::Named(named) => named,
        WinitKey::Dead(_) | WinitKey::Unidentified(_) => return Key::Named(NamedKey::Unidentified),
    };
    Key::Named(match named {
        WinitNamedKey::Backspace => NamedKey::Backspace,
        WinitNamedKey::Delete => NamedKey::Delete,
        WinitNamedKey::Enter => NamedKey::Enter,
        WinitNamedKey::Tab => NamedKey::Tab,
        WinitNamedKey::Space => return Key::Character(" ".to_owned()),
        WinitNamedKey::Escape => NamedKey::Escape,
        WinitNamedKey::ArrowLeft => NamedKey::ArrowLeft,
        WinitNamedKey::ArrowRight => NamedKey::ArrowRight,
        WinitNamedKey::ArrowUp => NamedKey::ArrowUp,
        WinitNamedKey::ArrowDown => NamedKey::ArrowDown,
        WinitNamedKey::Home => NamedKey::Home,
        WinitNamedKey::End => NamedKey::End,
        WinitNamedKey::PageUp => NamedKey::PageUp,
        WinitNamedKey::PageDown => NamedKey::PageDown,
        _ => format!("{named:?}")
            .parse()
            .unwrap_or(NamedKey::Unidentified),
    })
}

use servo::{
    InputEvent, Key, KeyState, KeyboardEvent, MouseButtonAction, MouseButtonEvent, MouseMoveEvent,
    NamedKey, WebView, WheelDelta, WheelEvent, WheelMode,
};
use std::{cell::Cell, rc::Rc};
use winit::{
    event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent},
    keyboard::{Key as WinitKey, ModifiersState, NamedKey as WinitNamedKey},
};

#[derive(Default)]
pub struct Input {
    point: servo::DevicePoint,
    modifiers: ModifiersState,
    composing: bool,
    ime_visible: Rc<Cell<bool>>,
}

impl Input {
    pub fn new(ime_visible: Rc<Cell<bool>>) -> Self {
        Self {
            ime_visible,
            ..Self::default()
        }
    }
    pub fn forward(&mut self, view: &WebView, event: WindowEvent) {
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
                keyboard.event.is_composing = self.composing;
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
                let (state, data) = match ime {
                    Ime::Enabled => return,
                    Ime::Preedit(text, _) => {
                        if !self.composing && text.is_empty() {
                            return;
                        }
                        if !self.composing && !text.is_empty() {
                            self.composing = true;
                            view.notify_input_event(InputEvent::Ime(servo::ImeEvent::Composition(
                                servo::CompositionEvent {
                                    state: servo::CompositionState::Start,
                                    data: String::new(),
                                },
                            )));
                        }
                        (servo::CompositionState::Update, text)
                    }
                    Ime::Commit(text) => {
                        self.composing = false;
                        (servo::CompositionState::End, text)
                    }
                    Ime::Disabled => {
                        self.composing = false;
                        // Disabling a context after a focus change is an acknowledgement,
                        // not a user dismissal of the newly focused element.
                        if self.ime_visible.replace(false) {
                            view.notify_input_event(InputEvent::Ime(servo::ImeEvent::Dismissed));
                        }
                        return;
                    }
                };
                InputEvent::Ime(servo::ImeEvent::Composition(servo::CompositionEvent {
                    state,
                    data,
                }))
            }
            _ => return,
        };
        view.notify_input_event(input);
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

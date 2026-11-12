#include <Arduino.h>

// GPIO number, not the module package's physical pin number.
constexpr uint8_t STOP_PIN = 13;
constexpr uint32_t DEBOUNCE_MS = 25;
int candidateLevel;
int stableLevel;
uint32_t changedAt;

void setup() {
  Serial.begin(115200);
  pinMode(STOP_PIN, INPUT_PULLDOWN);
  candidateLevel = stableLevel = digitalRead(STOP_PIN);
  changedAt = millis();
  // Booting while HIGH does not count as an L -> H transition.
  Serial.println("READY");
}

void loop() {
  const uint32_t now = millis();
  const int level = digitalRead(STOP_PIN);
  if (level != candidateLevel) {
    candidateLevel = level;
    changedAt = now;
  }
  // Accept a transition only after the input stays stable for 25 ms.
  if (candidateLevel != stableLevel &&
      static_cast<uint32_t>(now - changedAt) >= DEBOUNCE_MS) {
    const int previous = stableLevel;
    stableLevel = candidateLevel;
    if (previous == LOW && stableLevel == HIGH) {
      Serial.println("STOP_LOSS");
    }
  }
  delay(1);
}

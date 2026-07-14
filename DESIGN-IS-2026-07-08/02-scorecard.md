# Design Audit Scorecard

1. Good design is innovative — Score: 1/3
   Evidence: The screen follows a conventional status-dashboard plus side-control-panel pattern with no new interaction model. See `01-evidence.md#structural-evidence`.
   Justification: It is a working standard dashboard with minor variation, not a pattern that advances the form.

2. Good design makes a product useful — Score: 2/3
   Evidence: The primary task is directly supported by status sections, remote commands, and ACK logging, but the same status concepts are repeated across header badges, summary cards, and inner status sections. See `01-evidence.md#structural-evidence`.
   Justification: Users can complete the task, but adjacent duplicated surface adds scanning cost and decision friction.

3. Good design is aesthetic — Score: 1/3
   Evidence: The page uses 21 rendered/referenced colors, many spacing values, 5 top cards, nested status cards, and a separate log card. See `01-evidence.md#visual-evidence`.
   Justification: The UI has a visible system, but there are more than three inconsistencies and the card density is a jarring violation for an operations console.

4. Good design makes a product understandable — Score: 1/3
   Evidence: Key labels include unexplained `Broker`, `SSE`, `ACK`, `AP / STA / APSTA`, `UART Baud`, `BLE`, and `WebSocket`, while status is duplicated in several places. See `01-evidence.md#copy-and-honesty-evidence`.
   Justification: Engineers can infer it, but a first-time operator cannot name every primary control or status confidently without prior product knowledge.

5. Good design is unobtrusive — Score: 1/3
   Evidence: The chrome is prominent: cards inside cards, repeated borders, chips, and button blocks compete with the device state. See `01-evidence.md#visual-evidence`.
   Justification: The control surface draws attention to its containers instead of letting the current device state become the figure.

6. Good design is honest — Score: 3/3
   Evidence: No marketing inflation, dark pattern, or confirmed label-to-behavior mismatch was found. See `01-evidence.md#copy-and-honesty-evidence`.
   Justification: The page says what it does and the labels map to implemented monitoring/control behavior.

7. Good design is long-lasting — Score: 2/3
   Evidence: The design avoids fad gradients and decorative illustration, but it leans on a generic card-heavy SaaS dashboard idiom. See `01-evidence.md#visual-evidence`.
   Justification: It would not look absurd soon, but the visual language still carries a dated admin-template marker.

8. Good design is thorough down to the last detail — Score: 1/3
   Evidence: Empty, error, success, and disabled states exist, but loading is only a text swap and there is no explicit focus style; status-chip contrast also fails for normal text. See `01-evidence.md#visual-evidence` and `01-evidence.md#accessibility-evidence`.
   Justification: Several edge states exist functionally, but two to three important details are rough or missing.

9. Good design is environmentally friendly — Score: 0/3
   Evidence: The page is lightweight at 26,929 bytes and has no idle animation, but it explicitly sets `color-scheme: light`, so dark mode is ignored. See `01-evidence.md#weight-and-friction-evidence`.
   Justification: The scoring rubric assigns 0 when dark mode is ignored, even though the page is otherwise light.

10. Good design is as little design as possible — Score: 1/3
   Evidence: At least three layers show overlapping status information: header pills, summary cards, and status-section rows/chips. See `01-evidence.md#structural-evidence`.
   Justification: Three to five removable or mergeable elements are present, so the page is not yet reduced to the essential task.

## Total

13/30

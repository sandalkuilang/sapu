# Argus journey lane — Phase 7 research: what world-class UI quality is made of, measurably

The evidence behind the phase 7 plan ([argus-journey-lane-7-taste.md](argus-journey-lane-7-taste.md))
and spec §20. Every source below was fetched and read at its primary location (the vendor's own
guidelines, token files in the vendor's own repository, the standard's own text, the researcher's
own article). Each row records the claim the plan uses, quoted or stated briefly, and the decision it
informs (`D<n>` in the plan). A claim that could not be read at its source is listed under
"Unverified", and nothing in the plan depends on it.

**Ranking of evidence.** A measured fact from the plan's Task 0.1 probe outranks any document. Then a
vendor's token file (the numbers its own components ship), then the vendor's guideline text, then
standards (W3C, ISO), then research and practitioner writing. Token files were read from the
repository's default branch; guideline pages from the vendor's site. Page-rendered sites that serve
no text without JavaScript (Material's m3.material.io) were read through their token repositories
instead and say so.

**How a design system becomes a rule.** No single system's numbers become the bar. A rule enters
the bar only when it is a property several systems share (for example, "spacing comes from a small
fixed scale on a 4 or 8 px base") or a published threshold (NN/g's 0.1 s / 1 s / 10 s). Each
system's own values are kept as an optional *reference frame* an owner may pick (D4).

---

## Design systems and guidelines — the measurable rules

| Id | Source | Claim used | Informs |
|---|---|---|---|
| apple-lg | Apple, Adopting Liquid Glass — https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass | Liquid Glass "forms a distinct functional layer for controls and navigation elements". "Reduce your use of custom backgrounds in controls and navigation elements." Settings "reduce transparency or motion … test your app's custom elements, colors, and animations with different configurations of these settings." Controls use "rounded shapes that are concentric to their containers". "Avoid overusing Liquid Glass effects." | D7 restraint (one material layer, used sparingly), D9 motion under reduced-motion, D7 nested radii. |
| apple-materials | Apple HIG, Materials — https://developer.apple.com/design/human-interface-guidelines/materials | "Don't use Liquid Glass in the content layer." "Use Liquid Glass effects sparingly." Standard materials "help with visual differentiation within the content layer". | D7: elevation/translucency encodes layers, not decoration. |
| apple-motion | Apple HIG, Motion — https://developer.apple.com/design/human-interface-guidelines/motion | "Add motion purposefully … Don't add motion for the sake of adding motion. Gratuitous or excessive animation can distract people." "Make motion optional." "Aim for brevity and precision in feedback animations." | D9 motion rules. |
| apple-a11y | Apple HIG, Accessibility — https://developer.apple.com/design/human-interface-guidelines/accessibility | Names WCAG and APCA as "two popular standards" and then uses "values from WCAG Level AA": 4.5:1 up to 17 pt, 3:1 at 18 pt or bold. "Check the minimum contrast in both light and dark appearances." Default/minimum control sizes: iOS 44×44 / 28×28 pt, macOS 28×28 / 20×20 pt. Under Reduce Motion: reduce "automatic and repetitive animations, including zooming, scaling, and peripheral motion". | D8 contrast gate stays WCAG 2.2; D6 dark parity; D11 density per pointer. |
| apple-dark | Apple HIG, Dark Mode — https://developer.apple.com/design/human-interface-guidelines/dark-mode | "Avoid offering an app-specific appearance setting." "Ensure that your app looks good in both appearance modes." "At a minimum, make sure the contrast ratio between colors is no lower than 4.5:1. For custom foreground and background colors, strive for a contrast ratio of 7:1, especially in small text." | D6 dark-mode parity; D8 advisory 7:1 headroom. |
| apple-typo | Apple HIG, Typography — https://developer.apple.com/design/human-interface-guidelines/typography | Default/minimum text sizes per platform (iOS 17/11 pt, macOS 13/10 pt). "Keep text truncation to a minimum as font size increases." | D7 type floor; existing clipped check. |
| apple-layout | Apple HIG, Layout — https://developer.apple.com/design/human-interface-guidelines/layout | "Align elements to make them easier to scan, and use indentation to convey hierarchy … People assume that aligned items are related." | D7 alignment rule (aesthetics.md §5's 1–3 px band). |
| apple-loading | Apple HIG, Loading — https://developer.apple.com/design/human-interface-guidelines/loading | "Show something as soon as possible." Use a determinate indicator when the duration is known, indeterminate when not. | D10 perceived performance. |
| apple-genai | Apple HIG, Generative AI — https://developer.apple.com/design/human-interface-guidelines/generative-ai | "Set clear expectations about what your AI-powered feature can and can't do." "Instead of 'Processing…', say 'Finding substitutions for ingredients'." "If something goes wrong, describe what happened in plain language and offer a clear next step." "Ask for confirmation before performing a significant action on someone's behalf." | D14 AI-surface rules. |
| m3-tokens | Material 3 system tokens (material-web, `tokens/versions/latest/sass`) — https://github.com/material-components/material-web/tree/main/tokens/versions/latest/sass | Durations: short 50–200 ms, medium 250–400 ms, long 450–600 ms, extra-long 700–1000 ms. Easing standard `cubic-bezier(0.2, 0, 0, 1)`, emphasized decelerate `(0.05, 0.7, 0.1, 1)`. Springs: fast spatial damping 0.9 / stiffness 1400, slow spatial 0.9 / 300; effects springs damping 1 (no overshoot). Corners 0, 4, 8, 12, 16, 20, 28, 32, 48, full. Elevation levels 0, 1, 3, 6, 8, 12 px — six levels. | D9 duration band; D7 scale shape (a radius scale, few elevation levels). |
| m3-android-motion | Material Components Android, Motion — https://github.com/material-components/material-components-android/blob/master/docs/theming/Motion.md | Springs come in fast, default and slow, chosen "based on the size of the component being animated or the distance covered"; "spatial" springs may overshoot, "effects springs … should not be overshot (e.g. a background's alpha shouldn't bounce)". | D9: opacity/colour animations never overshoot. |
| m3-expressive | Google Design, Expressive Design: Google's UX Research — https://design.google/library/expressive-material-design-google-research | M3 Expressive came from "46 separate research studies … more than 18,000 participants". Participants "were able to spot key UI elements up to four times faster in the M3 Expressive designs"; a larger, more prominent Send button was seen "four times faster". | D7 hierarchy: one prominent primary action per view is a measurable property with a measured benefit. |
| vercel-wig | Vercel, Web Interface Guidelines (source of https://vercel.com/design/guidelines) — https://github.com/vercel-labs/web-interface-guidelines | "Honor `prefers-reduced-motion`." "Compositor-friendly … avoid properties that trigger reflows/repaints (`width`, `height`, `top`, `left`)." "Never `transition: all`." "Interruptible." Loading: "a short show-delay (~150–300 ms) & a minimum visible time (~300–500 ms) to avoid flicker." "Optimistic updates … On failure, show an error & roll back or provide Undo." "Stable skeletons … mirror final content exactly." "All states designed. Empty, sparse, dense, & error states." "No dead ends." "Nested radii. Child radius ≤ parent radius." "Interactions increase contrast." "Tabular numbers for comparisons." "Error messages guide the exit." "Keep nouns consistent." "Minimum contrast. Prefer APCA over WCAG 2." (a Vercel preference; see D8). | D9, D10, D12, D13, D7, D8. |
| geist | Vercel Geist, Colors and Typography — https://vercel.com/geist/colors, https://vercel.com/geist/typography | "There are 10 color scales … P3 colors are used on supported browsers." Two page backgrounds; colours 1–3 for component backgrounds (default, hover, active). Type is a closed set of named sizes (heading 72…14, button 16/14/12, label, copy). "Keep material shadows translucent." | D6 colour roles; D7 closed type set. |
| primer | GitHub Primer primitives — https://github.com/primer/primitives (`src/tokens/base/size/size.json5`, `base/motion/timing.json5`, `base/motion/easing.json5`, `functional/size/radius.json5`, `size-fine.json5`, `size-coarse.json5`) | Size scale 2, 4, 6, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 64, 80, 96, 112, 128 px. Durations 0–1000 ms in 50/100 ms steps. Radii small 3, medium 6, large 12, full. Control minimum target 16 px on a fine pointer, 44 px on a coarse one. | D7 scale; D11 density by pointer. |
| primer-patterns | Primer UI patterns: Loading, Saving, Empty states — https://primer.style/product/ui-patterns/loading/, https://primer.style/product/ui-patterns/saving/, https://primer.style/product/ui-patterns/empty-states/ | Determinate indicators "work best for processes that are likely to take longer (approximately 3 or more seconds)"; a content skeleton for "large areas of loading content". Saving: "Avoid mixing explicit and automatic save patterns on a single page … never mix save patterns in a single form"; on a save error "the user's data should be preserved in the form". | D10; D12 error recovery (input preserved); D13 consistency (one save pattern per form). |
| polaris | Shopify Polaris tokens — https://github.com/Shopify/polaris (`polaris-tokens/src/size.ts`, `themes/base/motion.ts`); README | Size scale on a 4 px base (`100` = 4 px … `3200` = 128 px); durations 0–500 ms in 50 ms steps. The README: "This repository is archived and unmaintained … The Shopify Polaris React library is deprecated", replaced by Polaris Web Components. | D7 scale shape; D4: Polaris is kept as a historical frame only, not a current reference. |
| atlassian | Atlassian Design System: Spacing, Elevation, Motion, Empty state, Error messages — https://atlassian.design/foundations/spacing, https://atlassian.design/foundations/elevation, https://atlassian.design/foundations/motion, https://atlassian.design/foundations/content/designing-messages/empty-state, https://atlassian.design/foundations/content/designing-messages/error-messages | "Our spacing system is built around a base unit of 8 pixels"; tokens are multiples of it, 0–80 px. Four elevations (sunken, default, raised, overlay) plus overflow; "in dark mode … the higher the elevation, the lighter the surface". Motion: interactions 50–150 ms, transitions 150–400 ms (dropdown 150 ms, modal 250 ms); "honors reduced-motion settings". Empty states: CTA with "imperative verbs … instead of vague terms such as 'OK'", "Limit your CTA to one or two words". Errors: "Avoid messaging that focuses on the problem without offering a solution or way forward." | D7 elevation layers; D9 duration band; D12 microcopy signals; D6 dark elevation. |
| carbon | IBM Carbon: Motion, Spacing, Loading, Empty states, Carbon for AI — https://carbondesignsystem.com/elements/motion/overview/, https://carbondesignsystem.com/elements/spacing/overview/, https://carbondesignsystem.com/patterns/loading-pattern/, https://carbondesignsystem.com/patterns/empty-states-pattern/, https://carbondesignsystem.com/guidelines/carbon-for-ai/ ; tokens in https://github.com/carbon-design-system/carbon (`packages/layout/src/index.ts`) | Durations fast-01 70 ms, fast-02 110 ms, moderate-01 150 ms, moderate-02 240 ms, slow-01 400 ms, slow-02 700 ms ("background dimming"). Two motion styles: productive ("subtle and out of the way") for task work, expressive "for occasional, important moments". Spacing 2, 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96, 160 px (`miniUnit = 8`). Skeletons "only on container-based components … data tables and cards", "only … for a few seconds"; action components "do not need to have a skeleton state". Empty states: no data, user action, error management. AI: "Use the AI label … to mark any instances of AI usage"; "Transparency of AI presence is key to user trust." | D9; D7; D10 skeleton rule; D12 state completeness; D14. |
| radix | Radix Colors, Understanding the scale — https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale | Twelve steps, each a role: 1–2 backgrounds, 3–5 component backgrounds (normal, hover, pressed), 6–8 borders and focus rings, 9–10 solid backgrounds, 11–12 text (low and high contrast). | D6: colour *roles*, so "one role, one value per theme" is checkable. |
| shadcn | shadcn/ui Theming — https://ui.shadcn.com/docs/theming | Tokens are role pairs (`primary` / `primary-foreground`) defined "under `:root` and `.dark`", in `oklch()`; radii derive from one `--radius`. | D6 role pairs per theme; D5 the token reader takes OKLCH custom properties (phase 6 `tokens` already normalises through the browser). |
| linear-redesign | Linear, How we redesigned the Linear UI — https://linear.app/now/how-we-redesigned-the-linear-ui | Themes moved from HSL to LCH ("a red and a yellow color with lightness 50 will appear roughly equally light"); "instead of having to define 98 specific variables for each theme, we defined three: base color, accent color, and contrast", the contrast variable giving "super high-contrast themes … for accessibility". Polishing reduced chrome colour and made "text and neutral icons darker in light mode and lighter in dark mode". | D6: colour from few generators, both themes from one system; D7 restraint. |
| linear-quality | Linear, Conversations on Quality — https://linear.app/quality | "What is quality? It seems hard to describe and even harder to measure, but you can feel it when it's there." | D1: the law (taste senses, measurement files) is exactly the answer to this. |
| stripe-color | Stripe, Designing accessible color systems — https://stripe.com/blog/accessible-color-systems | HSL lightness "is flawed": hues differ in perceived lightness; Stripe built its palette in a perceptually uniform space (CIELAB). "Any two colors are guaranteed to have sufficient contrast for small text if they are at least five levels apart, and at least four levels apart for icons and large text." | D6: a colour scale ordered by contrast makes role misuse measurable; D8. |
| cloudscape-density | AWS Cloudscape, Content density — https://cloudscape.design/foundation/visual-foundation/content-density/ | Two modes, comfortable (default) and compact "for data intensive views", "built using the 4px base unit"; compact "propagate[s] the reduced spacing scale to all components, in all view types". | D11: density is a mode applied consistently, so mixed density on one screen is measurable. |
| refactoring-ui | Refactoring UI (book site) — https://www.refactoringui.com/ | The table of contents: "Limit your choices", "Hierarchy is Everything", "Establish a spacing and sizing system", "Don't use grey text on colored backgrounds", "Define your shades up front", "Use shadows to convey elevation", "Use fewer borders" ("using too many of them can make your design feel busy and cluttered"). | D7 restraint metrics. Only the public site was read, not the book. |

## Platform capabilities (MDN, web.dev, W3C)

| Id | Source | Claim used | Informs |
|---|---|---|---|
| mdn-oklch | MDN, `oklch()` — https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/oklch | Baseline widely available. | D6: the probes resolve every colour through the browser (aesthetics.md §3.2's canvas), never parse strings. |
| mdn-color-mix | MDN, `color-mix()` — https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/color-mix | Baseline widely available. | D6: derived colours count as the role they derive from only through computed values. |
| mdn-container-type | MDN, `container-type` — https://developer.mozilla.org/en-US/docs/Web/CSS/container-type | Baseline widely available. | D11: density and layout are judged per component width, not only per viewport. |
| mdn-clamp | MDN, `clamp()` — https://developer.mozilla.org/en-US/docs/Web/CSS/clamp | Baseline widely available. | D7: fluid type is legitimate; the type census buckets computed sizes per viewport, never flags fluid sizes as off-scale. |
| mdn-view-transition | MDN, `Document.startViewTransition()` — https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition | Baseline 2025, newly available. | D9: view transitions are animations `document.getAnimations()` reports; the motion probe covers them. |
| mdn-popover | MDN, Popover API — https://developer.mozilla.org/en-US/docs/Web/API/Popover_API | Baseline 2025, newly available. | Existing offscreen probe already reads `[popover]`. |
| mdn-anchor | MDN, `anchor-name` and `position-area` — https://developer.mozilla.org/en-US/docs/Web/CSS/anchor-name, https://developer.mozilla.org/en-US/docs/Web/CSS/position-area | Baseline 2026, newly available. | No rule: a capability is never a requirement (D15). |
| mdn-animation-timeline | MDN, `animation-timeline` — https://developer.mozilla.org/en-US/docs/Web/CSS/animation-timeline | "Limited availability. This feature is not Baseline." | D15: scroll-driven animation is not required and not rewarded. |
| mdn-content-visibility | MDN, `content-visibility` — https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility | Baseline 2024, newly available. | D15: never required; long lists are judged by measured perf (phase 6). |
| mdn-prefers | MDN, `prefers-reduced-motion`, `prefers-contrast`, `prefers-color-scheme` — https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion, https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-contrast, https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme | All three Baseline widely available. | D6, D9: the taste project emulates `reducedMotion: "reduce"` and `colorScheme: "dark"`; honouring them is a fair expectation. |
| webdev-animations | web.dev, How to create high-performance CSS animations — https://web.dev/articles/animations-guide | "Before using any CSS property for animation (other than transform and opacity), determine the property's impact on the rendering pipeline. Avoid any property that triggers layout or paint." | D9: layout-property animation is a measured defect. |
| webdev-inp | web.dev, Interaction to Next Paint — https://web.dev/articles/inp | "When a page responds to an interaction, the browser presents visual feedback in the next frame that it paints." Good INP is ≤ 200 ms at the 75th percentile of field data. | D10: the feedback probe measures input to first visible change; INP thresholds stay lab context (phase 6). |
| webdev-cls | web.dev, Cumulative Layout Shift — https://web.dev/articles/cls | "Layout shifts that occur within 500 milliseconds of user input will have the hadRecentInput flag set." | D9: an animation that shifts layout outside that window is a shift the user did not cause. |
| webdev-baseline | web.dev, Baseline — https://web.dev/baseline | Baseline names features as newly or widely available across the core browsers. | D15: "modern" is never "uses new CSS"; a feature is only ever an implementation choice. |
| wcag3-wd | W3C, WCAG 3.0 Working Draft — https://www.w3.org/TR/wcag-3.0/ | "Text contrast sufficient (minimum)" is "Developing"; its text reads "@@[contrast measure to be determined]", and the editor's note says "The contrast algorithm used in WCAG 3 is yet to be determined." | D8: APCA is not a standard; WCAG 2.2 stays the gate. |
| apca | Myndex, apca-w3 README and LICENSE — https://github.com/Myndex/apca-w3 | Library version "0.1.9 … beta". "Licensed to the W3/AGWG per the collaborative agreement with specific limitations and exclusions"; LICENSE: "All Rights Reserved. Patent(s) pending … for use with WCAG accessibility guidelines … and not for any other use", with restrictions on using the name. | D8: sapu does not embed APCA (licence, beta, undetermined in WCAG 3). |
| wcag-233 | W3C, Understanding SC 2.3.3 Animation from Interactions (Level AAA) — https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html | "Motion animation triggered by interaction can be disabled, unless the animation is essential." Level AAA. | D9: reduced-motion is cited at its real level (AAA), so an unhonoured preference is never filed as an AA failure. |

## Perceived performance and interaction quality

| Id | Source | Claim used | Informs |
|---|---|---|---|
| nng-response | NN/g, Response Times: The 3 Important Limits — https://www.nngroup.com/articles/response-times-3-important-limits/ | "0.1 second is about the limit for having the user feel that the system is reacting instantaneously"; "1.0 second is about the limit for the user's flow of thought to stay uninterrupted"; "For delays of more than 1 second, indicate to the user that the computer is working"; "10 seconds … Anything slower than 10 seconds needs a percent-done indicator". | D10 thresholds. |
| nng-skeleton | NN/g, Skeleton Screens 101 — https://www.nngroup.com/articles/skeleton-screens/ | Skeletons are "used exclusively for full-page loads"; spinners "best used when the page takes 2–10 seconds", "on a single module"; skeletons "better when the full screen is loading"; above 10 s a progress bar; "If a page takes less than 1 second to load, skeleton scr[eens and spinners are not needed]". | D10 loader rules. |
| nng-progress | NN/g, Progress Indicators Make a Slow System Less Insufferable — https://www.nngroup.com/articles/progress-indicators/ | "Use a progress indicator for any action that takes longer than about 1.0 second." Looped animation "should be reserved for actions that take between 2-10 seconds. For anything that takes less than 1 second … it is distracting." | D10: a loader that flashes under its own display floor is a defect. |
| lux-doherty | Laws of UX, Doherty Threshold — https://lawsofux.com/doherty-threshold/ | "Provide system feedback within 400 ms"; origin Doherty and Thadani, IBM Systems Journal, 1982. | D10: 400 ms is shown as context, the filed thresholds are NN/g's. |

## Ease of use, measured

| Id | Source | Claim used | Informs |
|---|---|---|---|
| iso-9241-11 | ISO 9241-11:2018, the national-body preview of clauses 1–3 — https://preview.sist.si/sist-preview/63500/33c267a5a7564f298f02bbd65721a181/ISO-9241-11-2018.pdf | 3.1.1 usability: "extent to which a system, product or service can be used by specified users to achieve specified goals with effectiveness, efficiency and satisfaction in a specified context of use". 3.1.12 effectiveness: "accuracy and completeness"; 3.1.13 efficiency: "resources used in relation to the results achieved … time, human effort, costs and materials"; 3.1.14 satisfaction: the user's "physical, cognitive and emotional responses". | D2: effectiveness = the goal reached (phase 5 oracles); efficiency = measured resources (D3); satisfaction cannot be measured by a script and is never claimed. |
| klm | Kieras, Using the Keystroke-Level Model to Estimate Execution Times (course mirror) — https://www.cs.umd.edu/~golbeck/INST631/KSM.pdf | Operators: K keystroke 0.28 s for "the typical computer user"; P point 1.1 s on average, "the actual time required can be determined from Fitt's law"; BB click 0.2 s; H home hands 0.4 s; M mental act 1.2 s ("Choosing how many Ms are involved, and where they appear, is the hardest part"); W(t) waiting for the system. | D3: a path's KLM estimate. |
| fitts-mackenzie | MacKenzie, Fitts' law (Handbook of HCI chapter) — https://www.yorku.ca/mack/hhci2018.html | Fitts' index of difficulty, and the Shannon formulation `ID = log2(A/W + 1)`, which "provides better correlations" and "cannot be negative". | D3: pointer cost per step from measured geometry. |
| nng-fitts | NN/g, Fitts's Law and Its Applications in UX — https://www.nngroup.com/articles/fitts-law/ | "The movement time to a target depends on the size of the target and the distance to the target"; target width may be taken as the smaller dimension (MacKenzie and Buxton). | D3: `W` = the smaller side of the target's box. |
| nng-heuristics | NN/g, 10 Usability Heuristics — https://www.nngroup.com/articles/ten-usability-heuristics/ | 1 Visibility of system status ("appropriate feedback within a reasonable amount of time"); 4 Consistency and standards ("Users should not have to wonder whether different words, situations, or actions mean the same thing"); 7 Flexibility and efficiency of use (shortcuts "hidden from novice users"); 8 Aesthetic and minimalist design ("Every extra unit of information … diminishes their relative visibility"). | D2 the rule families; D13 consistency; D7 restraint; D14 keyboard reach. |
| nng-consistency | NN/g, Maintain Consistency and Adhere to Standards — https://www.nngroup.com/articles/consistency-and-standards/ | Internal consistency: "the same patterns everywhere inside the system"; e.g. "modals that are designed with the primary button on the right and the secondary buttons on the left". | D13 consistency probe (same action, same control, wording and placement). |
| nng-learnability | NN/g, How to Measure Learnability — https://www.nngroup.com/articles/measure-learnability/ | Learnability is "how easy it is for users to accomplish a task the first time … and how many repetitions it takes for them to become efficient"; it is measured with a learning curve over repeated trials. | D3: a script cannot measure human learning; the lane measures first-encounter discoverability (the cognitive walkthrough) only and names it so. |
| nng-errors | NN/g, Error-Message Guidelines — https://www.nngroup.com/articles/error-message-guidelines/ | "Display the error message close to the error's source"; "Use human-readable language … Avoid technical jargon"; "Preserve the user's input. Let users correct errors by editing their original" input. | D12 error recovery cost; microcopy signals. |
| nng-empty | NN/g, Designing Empty States in Complex Applications — https://www.nngroup.com/articles/empty-state-interface-design/ | Empty states "communicate system status … increase learnability … deliver direct pathways for key tasks"; "Totally empty states cause confusion". | D12 state completeness (phase 6's empty check, plus a next step). |
| lux-hick | Laws of UX, Hick's Law — https://lawsofux.com/hicks-law/ | "The time it takes to make a decision increases with the number and complexity of choices." | D7 one primary action per view. |
| lux-jakob | Laws of UX, Jakob's Law — https://lawsofux.com/jakobs-law/ | "Users spend most of their time on other sites … users prefer your site to work the same way as all the other sites they already know." | D4: the reference corpus as the external-consistency frame. |
| nng-heuristic-8-aesthetic | (same page as nng-heuristics) | "This heuristic doesn't mean you have to use a flat design." | D15: no style is required. |

## Current patterns

| Id | Source | Claim used | Informs |
|---|---|---|---|
| superhuman-cmdk | Superhuman, How to build a remarkable command palette — https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/ | "Cmd+K is used by Superhuman, Linear, and Slack; while Cmd+Shift+P is used by Sublime and VS Code." "Make your command palette available everywhere." With a palette "keyboard shortcuts are easy to discover". | D14: when an app has a palette, it opens with the same chord on every screen of the journey (a consistency check), never "an app must have one". |
| teams-streaming | Microsoft Learn, Stream bot messages (Teams) — https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux | Informative updates while generating, then response streaming; "The Stop button … lets users control streaming responses by stopping them early. It's available by default during streaming." | D14 AI surfaces: stop available while streaming. |
| aisdk-chat | Vercel AI SDK, Chatbot (`useChat`) — https://ai-sdk.dev/docs/ai-sdk-ui/chatbot | Status `submitted`, `streaming`, `ready`, `error`; a Stop button enabled while submitted or streaming; regeneration of the last message. | D14: stop while streaming, regenerate after, an error state. |
| pair | Google PAIR, Explainability + Trust — https://pair.withgoogle.com/chapter/explainability-trust/ | "Help users calibrate their trust … the user shouldn't trust the system completely"; how to "show users the confidence associated with an AI prediction". | D14: an AI answer carries its provenance or uncertainty (judgment, Curator). |

## The reference corpus — why each site is admitted

The owner asked for the best websites as the yardstick. A site is admitted only when a primary
source read here says why its interface is held to a high bar: the company publishes its design
system or interface guidelines, or its own craft writing about UI quality, or it holds a verifiable
design award. Awards were checked and were thin evidence: Awwwards lists Stripe Sessions with an
Honorable Mention (https://www.awwwards.com/sites/stripe-sessions-2024), and no Awwwards page was
found for Linear, Vercel, Raycast or Framer; the Arc page found on Awwwards is a different company's
site. Awwwards and similar juries reward marketing creativity, not product-UI quality, so the
corpus rests on published design systems and craft writing.

| Site | Admitted for | Justification read |
|---|---|---|
| Apple (apple.com, the HIG pages) | marketing, docs | apple-lg, apple-materials, apple-motion and the rest of the HIG rows |
| Vercel (vercel.com, vercel.com/docs) | marketing, docs | vercel-wig, geist |
| GitHub (public repository, issue-list, pull-request pages; docs.github.com; primer.style) | app chrome, data-dense lists, docs | primer, primer-patterns; `robots.txt` allows issue lists (it disallows `/issues/new` and `/issues/search`); the Acceptable Use Policies let researchers "use public, non-personal information … for research purposes, only if any publications resulting from that research are open access" — https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies |
| Stripe (stripe.com, docs.stripe.com) | marketing, docs | stripe-color; Awwwards Honorable Mention for Stripe Sessions |
| Linear (linear.app public pages) | marketing | linear-redesign, linear-quality, The Linear Method (https://linear.app/method: "There is a lost art of building true quality software") |
| IBM Carbon (carbondesignsystem.com) | docs, component demos (forms, data tables) | carbon |
| Atlassian (atlassian.design) | docs | atlassian |
| shadcn/ui (ui.shadcn.com, including its public Dashboard and Tasks examples) | docs, app/dashboard demo, data table demo | shadcn; the examples render a full app shell and a task table publicly (https://ui.shadcn.com/examples/dashboard, https://ui.shadcn.com/examples/tasks); `robots.txt` allows `/` |
| Figma (figma.com public pages) | marketing | Figma, Behind our redesign UI3 — https://www.figma.com/blog/behind-our-redesign-ui3/ ("we aimed to focus the canvas less on our UI and more on your work") |
| Raycast (raycast.com) | marketing | Raycast, A Technical Deep Dive Into the New Raycast — https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast ("the details that make it feel fast, delightful, and familiar"); its product is a desktop app, so marketing only |

**Not admitted** (no primary justification could be read): Notion, Airbnb (the design site's
visual-language article returned 404), Framer (its site was fetched but no craft or design-system
source was read), Arc (no award or craft source found at its own address). Each can join through the
update procedure once a source is read.

**Terms review.** Each admitted site's terms were read before a page joined the corpus
(`scripts/taste-corpus.json` records who reviewed them and what they say). Apple, Figma and Raycast
left: their terms bar robots or data mining outright. IBM Carbon left too: its terms let a crawler
crawl as `robots.txt` permits but bar a robot that retrieves or data-mines the site's presentation,
ambiguous for these pages; its published numbers stay a frame of the bar (D5), read, not crawled.

**Coverage by archetype, plainly.** Docs: covered: 18 pages from five sites (Vercel, GitHub,
Stripe, Atlassian, shadcn), the witness threshold of five sites and 15 pages. Marketing/landing:
thin: 15 pages from three sites (Vercel, Stripe, Linear); Apple, Figma and Raycast left on the terms
review, their terms barring robots. App/dashboard: thin: real logged-in app chrome is public only on
GitHub's repository pages and in the shadcn examples; Linear, Vercel, Stripe and Figma dashboards
need a login and are out. Form/checkout/settings: thin: one shadcn form demo and Stripe's checkout
demo; settings pages all need a login. Data-dense tables: thin: a GitHub issue list and the shadcn
task table. IBM Carbon left the corpus too: its terms are ambiguous about robots that data mine. No
site gives more than half of an archetype's pages. The plan therefore lets only archetypes with
enough references act as a witness (D5).

**Robots and terms observed.** `robots.txt` read for github.com, linear.app, stripe.com (its `*`
group allows `/docs`), vercel.com (its `*` group carries `Content-Signal: search=yes, ai-input=yes,
ai-train=no`) and ui.shadcn.com. Calibration trains nothing and stores numbers only (D16).

## Unverified

Nothing in the plan depends on these.
- **Material 3 guidelines pages** (m3.material.io, including the M3 Expressive blog) render nothing
  without JavaScript; their numbers were read from the token repository (m3-tokens) instead, and
  the expressive research from design.google (m3-expressive). M3 Expressive's own component specs
  were not read.
- **Polaris guideline pages** (polaris-react.shopify.com) now redirect to shopify.dev's Polaris Web
  Components pages; only the archived token files and README were read.
- **Microsoft HAX guidelines** (https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/) render
  without their text, and the CHI paper's PDF returned 503.
- **NN/g on command palettes, KLM and AI chat**: the guessed article addresses returned 404.
- **The KLM's original paper** (Card, Moran and Newell, CACM) returned 403 at the ACM; the Kieras
  tutorial was read instead.
- **ISO 9241-11's full text** is paywalled; clauses 1–3 were read in the national-body preview.
- **Refactoring UI's chapters** were not read; only the public site's table of contents and excerpt.
- **The Stripe Checkout public demo** (https://checkout.stripe.dev/) served only a shell without
  JavaScript; whether it renders real Checkout chrome is checked in calibration (Task K1), not
  assumed.
- **Apple Design Award records** for Arc, Raycast, Notion or Figma: only secondary search results,
  which named Arc Search a finalist; not used.

## Gaps this research closed (the plan changed)

1. APCA is not adoptable: WCAG 3 has not chosen a contrast algorithm [wcag3-wd], and APCA's code is
   beta and licensed for WCAG work only, all rights reserved, patents pending [apca]. Vercel's
   guideline prefers it [vercel-wig] and Apple names it [apple-a11y], but both still state WCAG 2
   numbers. The bar keeps WCAG 2.2 as the gate and adds a WCAG-ratio *headroom* advisory instead
   (Apple's 7:1 for small text) [apple-dark].
2. Every researched system bounds UI motion durations: interactions 50–150 ms, transitions
   150–400 ms, with 700 ms only for backdrop dimming [atlassian, carbon, m3-tokens, primer]. The
   bar's motion band comes from that overlap.
3. Loading has two thresholds, not one: no loader under 1 s, spinners for a module at 2–10 s,
   skeletons for a full screen, progress above 10 s [nng-skeleton, nng-progress, nng-response], and
   a loader that does appear stays long enough not to flash [vercel-wig].
4. "Ease of use" splits per ISO 9241-11 into effectiveness, efficiency and satisfaction
   [iso-9241-11]; a script measures the first two only. Efficiency has an established
   operator-level model [klm] with pointer cost from Fitts' law [fitts-mackenzie].
5. Density is a *mode* applied to all components [cloudscape-density] and depends on the pointer
   [primer, apple-a11y]; mixed density on one screen is the defect, not density itself.
6. Polaris React is archived [polaris]; it stays a historical frame, not a current reference.

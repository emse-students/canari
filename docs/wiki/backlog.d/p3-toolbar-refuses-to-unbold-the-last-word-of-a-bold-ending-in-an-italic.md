## P3 - the toolbar refuses to un-bold the last word of a bold that ends in an italic

`Le **prix *réduit***` with Bold on "réduit" should give `Le **prix** *réduit*`: the bold stops at the
italic, which keeps its own text. The toolbar refuses it today (the model writes the shared closing
edge with underscores only where no letter touches the run, and here the italic's closing edge
touches the word, so marked would not draw the output as promised): the text stays unchanged and
the member sees the "cannot apply this style here" toast. The fix is a spelling rule for a run
that shares its closing edge with another and cannot take underscores, probably writing the
inner run as the outer one so the two stars never touch. The mechanism, the rules already derived
and the refusal rates are in [markdown-coherence](../frontend/markdown-coherence.md); the
acceptance is a row of `markdownParity.test.ts` for this exact text, and the realistic fuzz family
of `composerFormatFuzz.test.ts` staying at its refusal bound.

/**
 * The compact EXCEPTIONS dictionary (CMUdict pronunciations): function words,
 * irregular spellings, number words, letter names and contractions — the
 * words letter-to-sound rules get wrong most often, weighted by frequency.
 * One string, parsed once on first use; it only ever ships in the lazy
 * `/g2p` chunk. Format: `word PHONEMES` per line.
 */
export const DICT_SOURCE = `
a AH0
a. EY1
about AH0 B AW1 T
above AH0 B AH1 V
across AH0 K R AO1 S
add AE1 D
after AE1 F T ER0
again AH0 G EH1 N
against AH0 G EH1 N S T
ago AH0 G OW1
ain't EY1 N T
air EH1 R
all AO1 L
almost AO1 L M OW2 S T
alone AH0 L OW1 N
along AH0 L AO1 NG
already AO0 L R EH1 D IY0
also AO1 L S OW0
always AO1 L W EY2 Z
am AE1 M
among AH0 M AH1 NG
an AE1 N
and AH0 N D
animal AE1 N AH0 M AH0 L
animation AE2 N AH0 M EY1 SH AH0 N
another AH0 N AH1 DH ER0
answer AE1 N S ER0
any EH1 N IY0
anyone EH1 N IY0 W AH2 N
anything EH1 N IY0 TH IH2 NG
are AA1 R
aren't AA1 R AH0 N T
around ER0 AW1 N D
as AE1 Z
ask AE1 S K
at AE1 T
atom AE1 T AH0 M
away AH0 W EY1
back B AE1 K
be B IY1
beautiful B Y UW1 T AH0 F AH0 L
because B IH0 K AO1 Z
been B IH1 N
before B IH0 F AO1 R
began B IH0 G AE1 N
begin B IH0 G IH1 N
being B IY1 IH0 NG
below B IH0 L OW1
better B EH1 T ER0
between B IH0 T W IY1 N
big B IH1 G
billion B IH1 L Y AH0 N
blue B L UW1
body B AA1 D IY0
book B UH1 K
both B OW1 TH
boy B OY1
bread B R EH1 D
break B R EY1 K
brother B R AH1 DH ER0
build B IH1 L D
busy B IH1 Z IY0
but B AH1 T
buy B AY1
by B AY1
call K AO1 L
came K EY1 M
can K AE1 N
can't K AE1 N T
car K AA1 R
character K EH1 R IH0 K T ER0
children CH IH1 L D R AH0 N
city S IH1 T IY0
close K L OW1 S
color K AH1 L ER0
colour K AH1 L ER0
come K AH1 M
could K UH1 D
couldn't K UH1 D AH0 N T
country K AH1 N T R IY0
cut K AH1 T
day D EY1
dear D IH1 R
did D IH1 D
didn't D IH1 D AH0 N T
different D IH1 F ER0 AH0 N T
do D UW1
does D AH1 Z
doesn't D AH1 Z AH0 N T
doing D UW1 IH0 NG
dollar D AA1 L ER0
dollars D AA1 L ER0 Z
don't D OW1 N T
done D AH1 N
door D AO1 R
down D AW1 N
each IY1 CH
early ER1 L IY0
earth ER1 TH
eat IY1 T
eight EY1 T
eighteen EY0 T IY1 N
eighth EY1 T TH
eighty EY1 T IY0
eleven IH0 L EH1 V AH0 N
else EH1 L S
end EH1 N D
enough IH0 N AH1 F
even IY1 V IH0 N
every EH1 V ER0 IY0
everyone EH1 V R IY0 W AH2 N
everything EH1 V R IY0 TH IH2 NG
example IH0 G Z AE1 M P AH0 L
eye AY1
face F EY1 S
family F AE1 M AH0 L IY0
far F AA1 R
father F AA1 DH ER0
few F Y UW1
fifteen F IH0 F T IY1 N
fifth F IH1 F TH
fifty F IH1 F T IY0
find F AY1 N D
first F ER1 S T
five F AY1 V
follow F AA1 L OW0
food F UW1 D
for F AO1 R
form F AO1 R M
forty F AO1 R T IY0
found F AW1 N D
four F AO1 R
fourteen F AO1 R T IY1 N
friend F R EH1 N D
from F R AH1 M
front F R AH1 N T
get G EH1 T
girl G ER1 L
give G IH1 V
go G OW1
goes G OW1 Z
gone G AO1 N
good G UH1 D
got G AA1 T
great G R EY1 T
group G R UW1 P
grow G R OW1
had HH AE1 D
half HH AE1 F
hand HH AE1 N D
happy HH AE1 P IY0
hard HH AA1 R D
has HH AE1 Z
have HH AE1 V
he HH IY1
he's HH IY1 Z
head HH EH1 D
hear HH IY1 R
heart HH AA1 R T
hello HH AH0 L OW1
help HH EH1 L P
her HH ER1
here HH IY1 R
hi HH AY1
high HH AY1
him HH IH1 M
his HH IH1 Z
home HH OW1 M
house HH AW1 S
how HH AW1
hundred HH AH1 N D R AH0 D
i AY1
i'd AY1 D
i'll AY1 L
i'm AY1 M
i've AY1 V
idea AY0 D IY1 AH0
if IH1 F
important IH0 M P AO1 R T AH0 N T
in IH0 N
into IH1 N T UW0
is IH1 Z
isn't IH1 Z AH0 N T
it IH1 T
it's IH1 T S
its IH1 T S
just JH AH1 S T
keep K IY1 P
kind K AY1 N D
know N OW1
land L AE1 N D
large L AA1 R JH
last L AE1 S T
later L EY1 T ER0
laugh L AE1 F
learn L ER1 N
leave L IY1 V
left L EH1 F T
let L EH1 T
let's L EH1 T S
letter L EH1 T ER0
life L AY1 F
light L AY1 T
like L AY1 K
line L AY1 N
listen L IH1 S AH0 N
little L IH1 T AH0 L
live L IH1 V
long L AO1 NG
look L UH1 K
lose L UW1 Z
love L AH1 V
made M EY1 D
make M EY1 K
man M AE1 N
many M EH1 N IY0
may M EY1
me M IY1
mean M IY1 N
men M EH1 N
might M AY1 T
million M IH1 L Y AH0 N
minus M AY1 N AH0 S
minute M IH1 N AH0 T
money M AH1 N IY0
more M AO1 R
morning M AO1 R N IH0 NG
most M OW1 S T
mother M AH1 DH ER0
mouth M AW1 TH
move M UW1 V
much M AH1 CH
music M Y UW1 Z IH0 K
must M AH1 S T
my M AY1
name N EY1 M
near N IH1 R
need N IY1 D
never N EH1 V ER0
new N UW1
next N EH1 K S T
night N AY1 T
nine N AY1 N
nineteen N AY1 N T IY1 N
ninety N AY1 N T IY0
ninth N AY1 N TH
no N OW1
none N AH1 N
not N AA1 T
nothing N AH1 TH IH0 NG
now N AW1
number N AH1 M B ER0
o'clock AH0 K L AA1 K
of AH1 V
off AO1 F
often AO1 F AH0 N
oh OW1
ok OW2 K EY1
okay OW2 K EY1
old OW1 L D
on AA1 N
once W AH1 N S
one W AH1 N
only OW1 N L IY0
open OW1 P AH0 N
or AO1 R
other AH1 DH ER0
our AW1 ER0
out AW1 T
over OW1 V ER0
own OW1 N
page P EY1 JH
paper P EY1 P ER0
part P AA1 R T
people P IY1 P AH0 L
percent P ER0 S EH1 N T
picture P IH1 K CH ER0
place P L EY1 S
play P L EY1
please P L IY1 Z
plus P L AH1 S
point P OY1 N T
pretty P R IH1 T IY0
put P UH1 T
question K W EH1 S CH AH0 N
quiet K W AY1 AH0 T
read R IY1 D
ready R EH1 D IY0
really R IH1 L IY0
right R AY1 T
river R IH1 V ER0
said S EH1 D
same S EY1 M
saw S AO1
say S EY1
says S EH1 Z
school S K UW1 L
sea S IY1
second S EH1 K AH0 N D
see S IY1
seem S IY1 M
seven S EH1 V AH0 N
seventeen S EH1 V AH0 N T IY1 N
seventy S EH1 V AH0 N T IY0
she SH IY1
she's SH IY1 Z
should SH UH1 D
shouldn't SH UH1 D AH0 N T
show SH OW1
side S AY1 D
six S IH1 K S
sixteen S IH0 K S T IY1 N
sixty S IH1 K S T IY0
small S M AO1 L
so S OW1
some S AH1 M
someone S AH1 M W AH2 N
something S AH1 M TH IH0 NG
sometimes S AH1 M T AY2 M Z
son S AH1 N
song S AO1 NG
soon S UW1 N
sorry S AA1 R IY0
sound S AW1 N D
start S T AA1 R T
still S T IH1 L
story S T AO1 R IY0
study S T AH1 D IY0
such S AH1 CH
sure SH UH1 R
take T EY1 K
talk T AO1 K
tell T EH1 L
ten T EH1 N
than DH AE1 N
thank TH AE1 NG K
thanks TH AE1 NG K S
that DH AE1 T
that's DH AE1 T S
the DH AH0
their DH EH1 R
them DH EH1 M
then DH EH1 N
there DH EH1 R
there's DH EH1 R Z
these DH IY1 Z
they DH EY1
they're DH EH1 R
thing TH IH1 NG
think TH IH1 NG K
third TH ER1 D
thirteen TH ER1 T IY1 N
thirty TH ER1 D IY0
this DH IH1 S
those DH OW1 Z
though DH OW1
thought TH AO1 T
thousand TH AW1 Z AH0 N D
three TH R IY1
through TH R UW1
time T AY1 M
to T UW1
today T AH0 D EY1
together T AH0 G EH1 DH ER0
told T OW1 L D
tomorrow T AH0 M AA1 R OW2
too T UW1
took T UH1 K
toward T AH0 W AO1 R D
tree T R IY1
trillion T R IH1 L Y AH0 N
true T R UW1
try T R AY1
turn T ER1 N
twelfth T W EH1 L F TH
twelve T W EH1 L V
twenty T W EH1 N T IY0
two T UW1
under AH1 N D ER0
until AH0 N T IH1 L
up AH1 P
upon AH0 P AA1 N
us AH1 S
use Y UW1 Z
very V EH1 R IY0
voice V OY1 S
walk W AO1 K
want W AA1 N T
was W AA1 Z
wasn't W AA1 Z AH0 N T
watch W AA1 CH
water W AO1 T ER0
way W EY1
we W IY1
we'll W IY1 L
we're W IH1 R
we've W IY1 V
well W EH1 L
went W EH1 N T
were W ER1
what W AH1 T
what's W AH1 T S
when W EH1 N
where W EH1 R
which W IH1 CH
while W AY1 L
white W AY1 T
who HH UW1
whole HH OW1 L
whose HH UW1 Z
why W AY1
will W IH1 L
with W IH1 DH
without W IH0 TH AW1 T
woman W UH1 M AH0 N
women W IH1 M AH0 N
won't W OW1 N T
word W ER1 D
work W ER1 K
world W ER1 L D
would W UH1 D
wouldn't W UH1 D AH0 N T
write R AY1 T
year Y IH1 R
yes Y EH1 S
yesterday Y EH1 S T ER0 D EY2
you Y UW1
you'll Y UW1 L
you're Y UH1 R
you've Y UW1 V
young Y AH1 NG
your Y AO1 R
zero Z IH1 R OW0
`;

/** Letter names, for spelled-out acronyms ("FBI", "AI"). */
export const LETTER_NAMES: Record<string, string> = {
  a: "EY1", b: "B IY1", c: "S IY1", d: "D IY1", e: "IY1", f: "EH1 F", g: "JH IY1", h: "EY1 CH", i: "AY1",
  j: "JH EY1", k: "K EY1", l: "EH1 L", m: "EH1 M", n: "EH1 N", o: "OW1", p: "P IY1", q: "K Y UW1", r: "AA1 R",
  s: "EH1 S", t: "T IY1", u: "Y UW1", v: "V IY1", w: "D AH1 B AH0 L Y UW0", x: "EH1 K S", y: "W AY1", z: "Z IY1",
};

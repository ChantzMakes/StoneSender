( 02-arcs-all-planes.nc — arcs in G17, G18 and G19, IJK and R forms, CW and CCW. )
( Air-cut test: runs 10 mm above Z0. )
G21 G90 G94
G0 Z10
G0 X0 Y0

( G17 XY plane: full circle, IJK )
G17
G1 X10 Y0 F1500
G2 X10 Y0 I-10 J0
( half circle, R form, CCW )
G3 X-10 Y0 R10
( long way round with negative R )
G2 X0 Y10 R-10
G0 X0 Y0

( G18 ZX plane )
G18
G1 X10 Z10 F1000
G2 X-10 Z10 I-10 K0
G3 X10 Z10 R10

( G19 YZ plane )
G19
G0 X0 Y10 Z10
G2 Y-10 Z10 J-10 K0
G3 Y10 Z10 J10 K0

( helix: arc with linear Z )
G17
G0 X10 Y0 Z10
G2 X10 Y0 Z5 I-10 J0

G0 Z15
M30

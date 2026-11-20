( 04-laser-vector.nc — laser vector: 40 mm square with an inscribed circle. )
( Requires a laser profile with $32=1. Uses M4 dynamic power and M8 air assist. )
G21 G90 G17 G94
M8
G0 X0 Y0
M4 S0
G1 X40 Y0 S600 F1500
G1 X40 Y40
G1 X0 Y40
G1 X0 Y0
G0 X20 Y5 S0
G2 X20 Y5 I0 J15 S800 F1200
M5
M9
G0 X0 Y0
M2

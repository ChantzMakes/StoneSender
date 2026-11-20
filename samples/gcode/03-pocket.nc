( 03-pocket.nc — 40 x 30 mm rectangular pocket, 3 mm deep, 6 mm flat end mill, 1 mm steps. )
( Offset raster clearing; inch/mm switch near the end exercises G20/G21 handling. )
G21 G90 G17 G94
T1 M6
M3 S16000
G4 P4
G0 Z5
G0 X3 Y3
G1 Z-1 F250
G1 X37 F1000
G1 Y7
G1 X3
G1 Y11
G1 X37
G1 Y15
G1 X3
G1 Y19
G1 X37
G1 Y23
G1 X3
G1 Y27
G1 X37
G1 Y3
G1 X3
G1 Y27
G1 Z-2 F250
G1 X37 F1000
G1 Y3
G1 X3
G1 Y27
G1 Z-3 F250
G1 X37 F1000
G1 Y3
G1 X3
G1 Y27
G0 Z5
( same retract expressed in inches )
G20
G0 Z0.3
G21
M5
M30

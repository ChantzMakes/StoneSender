( 06-rotary-a-axis.nc — true 4th axis: helical groove on 50 mm stock. )
( Requires a rotary profile with an A axis (grblHAL / 4-axis GRBL). Z0 = stock centreline. )
G21 G90 G94
M3 S12000
G4 P4
G0 Z30
G0 X0 A0
G1 Z24 F300
G1 X20 A180 F800
G1 X40 A360
G1 X60 A540
G1 X80 A720
G0 Z30
G0 A0
M5
M30

* bei Aufruf aus dem Menü Transaktion verlassen                        *
*----------------------------------------------------------------------*
  if menu ne space.                                         "HWR
    set screen 0.                                           "HWR
    leave screen.                                           "HWR
  endif.
endmodule.

*---------------------------------------------------------------------*
*       MODULE EXIT_COMMAND                                           *
*---------------------------------------------------------------------*
*       ........                                                      *
*---------------------------------------------------------------------*
module exit_command.
*----------------------------------------------------------------------*
* Abbruch behandeln                                                    *
*----------------------------------------------------------------------*
  set screen 0. leave screen.
endmodule.

*---------------------------------------------------------------------*
*       MODULE CHECK_VIEWNAME                                         *
*---------------------------------------------------------------------*
*       ........                                                      *
*---------------------------------------------------------------------*
module check_viewname.
  if viewname <> space.
    if cluster_ta = space.                                  "SW 261095
      set parameter id viewnam_paramid field viewname.
    else.
      set parameter id vclnam_paramid field vcldir-vclname.
    endif.                                                  "SW 261095
  elseif viewname eq space and ok_code <> 'VVCL' AND ok_code NE 'ACTV'.
    set pf-status 'ERROR'.
    if partcode = sy-tcode.
      message e062.
    else.
      message id 'EU' type 'S' number 203 with partcode.
      set screen 0. leave screen.
    endif.
  endif.
endmodule.

*---------------------------------------------------------------------*
*       MODULE CHECK_VARIANT                                          *
*---------------------------------------------------------------------*
*       ........                                                      *
*---------------------------------------------------------------------*
module check_variant.
  if vimdynflds-ltd_dta_vr ne space.
    select single * from tvimv where tabname eq viewname
                                 and variant eq tvimv-variant
                                 and as4pos eq '0001'.
    if sy-subrc ne 0.
      message e143 with tvimv-variant viewname.
    endif.
    variant = tvimv-variant.
  else.
    clear variant.
  endif.
endmodule.

*----------------------------------------------------------------------*
* Process Value-Request                                                *
*----------------------------------------------------------------------*
module variant_values.
  data: dynpfields like dynpread occurs 10 with header line,
        vv_ret(1) type c.

  dynpfields-fieldname = 'VIEWNAME'.
  append dynpfields.
  call function 'DYNP_VALUES_READ'
       exporting
            dyname             = 'SAPMSVMA'
            dynumb             = sy-dynnr
            translate_to_upper = 'X'
       tables
            dynpfields         = dynpfields.
  read table dynpfields index 1.
  perform show_valid_values(saplsvix) using dynpfields-fieldvalue
